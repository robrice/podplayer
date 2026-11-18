# Podplayer queue

Issues found while building that need Rob, a real iPhone, or a later decision.

## Needs Rob
- [ ] **Turn on the feed mirror.** The laptop's GitHub login can't publish workflow files. Rob runs `gh auth refresh -h github.com -s workflow` once (it shows a code to enter at github.com/login/device). Then Claude:
  - Pushes `.github/workflows/pages.yml`, which is written and in the working tree, not committed.
  - Switches Pages to the Actions build: `gh api -X PUT repos/robrice/podplayer/pages -f build_type=workflow`.

  Until then, NPR, Audioboom, NBC and Acast shows fall back to the unreliable public relay.
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
