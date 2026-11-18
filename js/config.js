// Defaults. Both can also be changed in the app's Settings tab.
export const CONFIG = {
  // Google OAuth "Web application" client ID (not a secret). Needed only for Drive music.
  googleClientId: '1075098357269-8bv806rpkfovo7t3ht9d5fc926osek4l.apps.googleusercontent.com',
  // Optional proxy for podcast feeds that block browsers: the /exec URL of apps-script/FeedProxy.gs.
  // The app calls `${proxy}?url=<encoded feed url>`.
  proxy: '',
  // Drive folders the Music tab shows (with their subfolders). Empty = all audio in Drive.
  musicFolders: ['https://drive.google.com/drive/folders/1ujyU2P7vssvobZ1MDx2pWLkHiwXqHVri'],   // "m4a music"
  // GitHub repo whose Actions job mirrors blocked feeds into this site (tools/mirror.py).
  repo: 'robrice/podplayer',
};
