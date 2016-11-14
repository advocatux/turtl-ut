var User = Protected.extend({
	base_url: '/users',
	local_table: 'user',

	relations: {
		settings: {
			collection: 'Settings'
		}
	},

	public_fields: [
		'id',
		'storage'
	],

	private_fields: [
		'settings'
	],

	logged_in: false,
	changing_password: false,

	auth: null,

	init: function()
	{
		this.logged_in = false;

		// whenever the user settings change, automatically save them (encrypted).
		this.bind_relational('settings', ['change'], this.save_settings.bind(this), 'user:save_settings');
	},

	login: function(data, options)
	{
		options || (options = {});

		this.set(data, {ignore_body: this.key ? false : true});
		return this.get_auth(options).bind(this)
			.then(function(auth) {
				this.unset('username');
				this.unset('password');
				this.logged_in = true;

				// now grab the user record by ID from the API.
				turtl.api.set_auth(auth);
				var promise = turtl.api.get('/users/'+this.id(), {}).bind(this)
					.then(function(user) {
						this.set(user);
						this.write_cookie();
						if(!options.silent) this.trigger('login', this);
					})
					.catch(function(err) {
						log.error('user: problem grabbing user record: ', derr(err));
					});
				turtl.api.clear_auth();
				return promise;
			});
	},

	login_from_auth: function(auth)
	{
		if(!auth) return false;
		this.set({id: auth.uid});
		this.auth = auth.auth;
		this.key = tcrypt.key_to_bin(auth.key);
		this.logged_in = true;
		this.trigger('login', this);
	},

	login_from_cookie: function()
	{
		var cookie = localStorage[config.user_cookie];
		if(!cookie) return false;

		var userdata = JSON.parse(cookie);
		var key = tcrypt.key_to_bin(userdata.k);
		var auth = userdata.a;
		delete userdata.k;
		delete userdata.a;
		this.key = key;
		this.auth = auth;
		this.set(userdata);
		this.logged_in = true;
		this.trigger('login', this);
	},

	/**
	 * add a new user.
	 *
	 * note that we don't do the usual model -> local db -> API pattern here
	 * because the local db relies on the user id (which is generated by the
	 * API) and because in the off-chance that there's a failure syncing the
	 * user record after the fact, it could serverely screw some things up in
	 * the client.
	 *
	 * instead, we post to the API, then once we have a full user record that we
	 * know is in the API, we wait for the local DB to init (poll it) and then
	 * add our shiny new user record to it.
	 */
	join: function(options)
	{
		options || (options = {});
		var data;
		return this.get_auth({skip_cache: true}).bind(this)
			.then(function(auth) {
				data = {data: {a: auth}};
				if(localStorage.invited_by)
				{
					data.invited_by = localStorage.invited_by;
				}

				/*
				// grab the promo code, if we haven't already used it.
				var used_promos = JSON.parse(localStorage.used_promos || '[]');
				var promo = options.promo;
				if(promo) //&& (!used_promos || !used_promos.contains(promo)))
				{
					data.promo = promo;
				}
				*/

				return turtl.api.post('/users', data);
			})
			.tap(function(user) {
				if(data.promo)
				{
					// if we used a promo, track it to make sure this client
					// doesn't use it again.
					//localStorage.used_promos = JSON.stringify(JSON.parse(localStorage.used_promos || '[]').push(data.promo));
				}

				// once we have a successful signup with the invite/promo, wipe
				// them out so we don't keep counting multiple times.
				delete localStorage.invited_by;
				delete localStorage.promo;

				// once we have the user record, wait until the user is logged
				// in. then we poll turtl.db until our local db object exists.
				// once we're sure we have it, we save the new user record to
				// the local db.
				this.bind('login', function() {
					this.unbind('login', 'user:join:add_local_record');
					var check_db = function()
					{
						if(!turtl.db)
						{
							check_db.delay(10, this);
							return false;
						}
						this.save();
					}.bind(this);
					check_db.delay(1, this);
				}.bind(this), 'user:join:add_local_record');
			});
	},

	/**
	 * Remove a user's account and all their data.
	 */
	delete_account: function(options)
	{
		return turtl.api._delete('/users/'+this.id())
			.then(function(res) {
				return turtl.wipe_local_db();
			})
			.then(function() {
				return turtl.user.logout();
			});
	},

	/**
	 * change the username/password.
	 *
	 * this assumes the current account has been verified, and does no checking
	 * itself.
	 *
	 * here's how this works:
	 *
	 *   1. generate a new master key using the new u/p
	 *   2. generate a new auth token using the new key
	 *   3. save the auth token to the API
	 *   4. use the new key to re-encrypt and save *every* keychain entry
	 *
	 * done! because all non-keychain objects are self-describing, we only need
	 * to encrypt keychain entries and we're good to go.
	 */
	change_password: function(username, password)
	{
		var old_auth, new_auth;
		var key;
		var user;

		if(this.changing_password)
		{
			// FORGET ABOUT IT
			return Promise.reject(new Error('there is already a password change in process'));
		}

		var syncval = config.sync_to_api;
		return this.get_auth().bind(this)
			.then(function(_old_auth) {
				old_auth = _old_auth;
				user = new User({username: username, password: password});
				return user.get_key({skip_cache: true}).bind(this)
			})
			.then(function(_key) {
				key = _key;
				return user.get_auth({skip_cache: true});
			})
			.then(function(_new_auth) {
				new_auth = _new_auth;
				var data = {data: {a: new_auth}};
				return turtl.api.put('/users/'+this.id(), data, {auth: old_auth})
			})
			.then(function(userdata) {
				config.sync_to_api = false;
				var keychain_actions = turtl.profile.get('keychain').map(function(kentry) {
					kentry.key = key;
					return kentry.save();
				});
				var persona_actions = turtl.profile.get('personas')
					.filter(function(persona) {
						return persona.get('user_id') == this.id();
					}.bind(this))
					.map(function(persona) {
						persona.key = key;
						return persona.save();
					});
				turtl.events.trigger('user:change-password:pre-save');
				this.changing_password = true;
				return Promise.all(keychain_actions.concat(persona_actions));
			})
			.then(function(saved) {
				turtl.events.trigger('user:change-password:post-save');
				log.info('keys/personas saved: ', saved.length);
				user.clear();
				this.key = key;
				this.auth = new_auth;
				turtl.api.set_auth(new_auth);
				this.trigger('change');
			})
			.catch(function(err) {
				this.rollback_change_password(new_auth)
					.catch(function(err) {
						turtl.events.trigger('ui-error', i18next.t('Sorry, we couldn\'t undo the password change operation. You really should try changing your password again, or your profile may be stuck in limbo.'), err);
						log.error('user: pw rollback: ', err);
					});
				throw err;
			})
			.finally(function() {
				config.sync_to_api = syncval;
				this.changing_password = false;
				turtl.events.trigger('user:change-password:finish');
			});
	},

	/**
	 * we're here because something went wrong while changing the password. we
	 * could be in some kind of key/auth/keychain limbo, so do our best to set
	 * it all right here (set auth back to original in API, re-save keychain
	 * entries with original key).
	 */
	rollback_change_password: function(new_auth)
	{
		return this.get_key()
			.then(function(key) {
				return this.get_auth();
			})
			.then(function(auth) {
				var data = {data: {a: auth}};
				return turtl.api.put('/users/'+this.id(), data, {auth: auth}).bind(this)
			})
			.catch(function(err) {
				return turtl.api.put('/users/'+this.id(), data, {auth: new_auth})
			})
			.then(function(userdata) {
				var actions = [];
				turtl.profile.get('keychain').each(function(kentry) {
					kentry.key = key;
					actions.push(kentry.save());
				}.bind(this));
				return Promise.all(actions);
			});
	},

	write_cookie: function(options)
	{
		options || (options = {});

		var key, auth;
		if(!config.cookie_login) return false;

		return this.get_key().bind(this)
			.then(function(_key) {
				key = _key;
				return this.get_auth();
			})
			.then(function(_auth) {
				auth = _auth;
				if(!key || !auth) return false;

				var save = {
					id: this.id(),
					k: tcrypt.key_to_string(key),
					a: auth,
					invite_code: this.get('invite_code'),
					storage: this.get('storage')
				};
				localStorage[config.user_cookie] = JSON.stringify(save);
			});
	},

	logout: function()
	{
		this.auth = null;
		this.key = null;
		this.logged_in = false;
		this.clear();
		delete localStorage[config.user_cookie];
		this.unbind_relational('personas', ['saved'], 'user:track_personas');
		this.unbind_relational('personas', ['destroy'], 'user:track_personas:destroy');
		this.unbind_relational('settings', ['change'], 'user:save_settings');

		// clear user data
		var personas = this.get('personas');
		if(personas) personas.each(function(p) {
			p.unbind();
			p.destroy({silent: true, skip_remote_sync: true, skip_local_sync: true});
		});
		var personas = this.get('personas');
		if(personas) personas.unbind().clear();
		this.get('settings').unbind().clear();
		this.trigger('logout', this);
	},

	save_settings: function()
	{
		this.save().bind(this)
			.then(function(res) {
				this.trigger('saved', res);
			})
			.catch(function(err) {
				log.error('error: user.save_settings: ', derr(err));
				throw err;
			});
	},

	get_key: function(options)
	{
		options || (options = {});
		var old = options.old;

		var key = this.key;
		if(key && !options.skip_cache) return Promise.resolve(key);

		var username = this.get('username');
		var password = this.get('password');

		if(!username || !password) return Promise.resolve(false);

		// allows custom iterations
		var iter = options.iterations || 100000;

		if(old)
		{
			// oh, how far i've come that this now makes me cringe. 400
			// iterations and an entropy-reducing hardcoded salt string.
			// luckily this was the first bit of crypto code i'd ever written
			var key = tcrypt.key(password, username + ':a_pinch_of_salt', {key_size: 32, iterations: 400});
			var promise = Promise.resolve(key);
		}
		else
		{
			// create a salt based off hashed username
			var salt = tcrypt.hash(username);
			var key = tcrypt.key_native(password, salt, {key_size: 32, iterations: iter, hasher: 'SHA-256'})
			var catcher = function(err) { return (err instanceof DOMException) || (err instanceof TcryptError); };
			var promise = Promise.resolve(key)
				.catch(catcher, function(err) {
					// probably some idiotic "safe origin" policy crap. revert to sync/SJCL method
					if(!(err instanceof DOMException))
					{
						log.error('user: get_key: ', err);
					}
					else
					{
						log.warn('user: get_key: fallback to sync', err);
					}
					return tcrypt.key(password, salt, {key_size: 32, iterations: iter, hasher: tcrypt.get_hasher('SHA256')});
				})
		}

		return promise.bind(this)
			.tap(function(key) {
				if(!options.skip_cache) this.key = key;
			});
	},

	get_auth: function(options)
	{
		options || (options = {});
		var old = options.old;

		if(this.auth && !options.skip_cache) return Promise.resolve(this.auth);

		var username = this.get('username');
		var password = this.get('password');

		if(!username || !password) return Promise.resolve(false);

		// generate (or grab existing) the user's key based on username/password
		return this.get_key(options).bind(this)
			.then(function(key) {
				// create a static IV (based on username) and a user record string
				// (based on hashed username/password). this record string will then be
				// encrypted with the user's key and sent as the auth token to the API.
				if(old)
				{
					// let's reduce entropy by using a hardcoded string. then if we XOR
					// the data via another string and base64 the payload, we've pretty
					// much got AES (but better, IMO).
					var iv = tcrypt.iv(username+'4c281987249be78a');
					var user_record = tcrypt.hash(password) +':'+ username;
					// note we serialize with version 0 (the original Turtl serialization
					// format) for backwards compat
					var auth = tcrypt.encrypt(key, user_record, {iv: iv, version: 0});
				}
				else
				{
					var iv = tcrypt.iv(tcrypt.hash(password + username));
					var user_record = tcrypt.hash(password) +':'+ tcrypt.hash(username);
					// supply a deterministic UTF8 "random" byte for the auth string
					// encryption so we get the same result every time (otherwise
					// tcrypt.encrypt will pick a random value for us).
					var utf8_random = parseInt(user_record.substr(18, 2), 16) / 256;
					var auth = tcrypt.to_base64(tcrypt.encrypt(key, user_record, {iv: iv, utf8_random: utf8_random}));
				}

				return auth;
			})
			.tap(function(auth) {
				if(!options.skip_cache) this.auth = auth;
			});
	},

	test_auth: function()
	{
		return this.get_auth({skip_cache: true}).bind(this)
			.then(function(auth) {
				return turtl.api.post('/auth', {}, {auth: auth})
			})
			.then(function(id) {
				return [id, {old: false}];
			})
			.catch(function(err) {
				if(err && err.xhr && err.xhr.status == 401)
				{
					// ok, login failed using the CORRECT keygen method, try the
					// old shitty version
					return this.get_auth({old: true, skip_cache: true}).bind(this)
						.then(function(auth) {
							turtl.api.set_auth(auth);
							return turtl.api.post('/auth', {})
						})
						.then(function(id) {
							// mark is as old so the user model knows to use it
							// from now on
							return [id, {old: true}];
						});
				}
				throw err;
			});
	}
});

// we don't actually use this collection for anything but syncing
var Users = SyncCollection.extend({
	model: User,
	local_table: 'user',

	sync_record_from_db: function(userdata, msg)
	{
		if(!userdata) return false;
		if(turtl.sync.should_ignore([msg.sync_id], {type: 'local'})) return false;

		turtl.user.set(userdata);
	},

	sync_record_from_api: function(item)
	{
		// make sure item.key is set so the correct record updates in the DB
		// (since we only ever get one user object synced: ours)
		item.key = 'user';
		return this.parent.apply(this, arguments);
	}
});
