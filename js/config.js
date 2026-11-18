// Defaults. Both can also be changed in the app's Settings tab.
export const CONFIG = {
  // Google OAuth "Web application" client ID (not a secret). Needed only for Drive music.
  googleClientId: '',
  // Optional proxy for podcast feeds that block browsers: the /exec URL of apps-script/FeedProxy.gs.
  // The app calls `${proxy}?url=<encoded feed url>`.
  proxy: '',
  // GitHub repo whose Actions job mirrors blocked feeds into this site (tools/mirror.py).
  repo: 'robrice/podplayer',
};
