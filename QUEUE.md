# Podplayer queue

Issues found while building that need Rob, a real iPhone, or a later decision.

## Needs Rob
- [x] **Feed mirror turned on** (Nov 17). Rob granted workflow scope, the workflow was pushed, and Pages switched to the Actions build. 26 feeds are mirrored. The request flow was tested end to end with issue #1: the feed was mirrored, commented and labeled in about 2 minutes.
- [ ] **Drive music is untested end to end.** It needs the Google Cloud client ID (README, "One-time setup for Drive music"). After that, test sign-in on the iPhone home-screen app: the redirect leaves the app and returns, then list the folders and play the Gulag Archipelago parts in order.
- [ ] **Real-iPhone checks** (headless Chrome can't test these):
  - Lock-screen controls and artwork.
  - Playback continuing with the screen off.
  - Moving from one Drive track to the next while locked.
  - Resume after a force-quit.

## Known limits / ideas
- [x] **Feeds that block browsers** (NPR, Audioboom redirects): solved by the GitHub Actions feed mirror (README). The public relay remains only as a last resort.
- [ ] **Mirror requests need a GitHub login on the phone** the first time Rob taps "Request mirror".
- [ ] **Downloads for shows whose audio host blocks browsers** still fail, though they stream fine. In the top-100 test (Nov 17), 8 of 81 loadable shows were affected: SmartLess, Conan O'Brien Needs A Friend, Mel Robbins, BBC Global News, WSJ What's News, Small Town Murder, The Viall Files, Freakonomics. Ideas:
  - A binary relay, which needs a server such as a Cloudflare Worker (account needed).
  - Service-worker caching of opaque responses. Doubtful on iOS, which needs byte-range replies for audio.
- [ ] New episodes are fetched only when the app is open (an iOS rule for web apps).
