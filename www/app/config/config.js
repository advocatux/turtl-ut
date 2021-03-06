if(window.Composer) window.Composer.promisify({warn: true});

var config = {
	// filled in by extension/app from its manifest
	version: '0.4',

	// what client we're using
	client: 'core',

	api_url: 'http://api.turtl.it/v2',

	site_url: 'https://turtl.it',
	base_url: '',
	route_base: '',

	// used to tell us where to store auth. this is only used when serving turtl
	// as a webapp (big no no). the addons do their own auth.
	user_cookie: 'turtl:user:v2',

	cookie_login: true,

	// the amount of time we let a client not sync with the server before
	// forcing a profile refresh.
	sync_cutoff: (60 * 60 * 24 * 30),

	// if true, any uncaught errors will be logged to the API for processing
	catch_global_errors: false,

	// whether or not to sync data w/ server
	sync_to_api: true,
	poll_api_for_changes: true,

	// enable things like INVITE TO GET MOAR STORAGE
	enable_promo: false,

	// if a note is changed in the note editor, pop up a confirmation before
	// letting the unsaved changes get lost (due to modal closing)
	confirm_unsaved: true,

	// show a overlay under modals and above the main content (can be
	// overridden).
	modal_overlay: true
}
