# Podplayer

A free podcast player that also plays audio from your Google Drive. It's a web app you add to the iPhone home screen; there's nothing to install from the App Store and no subscription. Everything you do (subscriptions, positions, downloads) stays on the phone.

Live at: https://robrice.github.io/podplayer/

## Install on iPhone
1. Open the link above in **Safari** (not Chrome).
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Open it from the home screen icon. It runs full screen and keeps playing with the phone locked.

## Features
- **Podcasts:** search Apple's podcast directory, subscribe, mark played, Up Next queue, OPML import/export.
- **Player:** back 15 s / forward 30 s, speed 0.8–2×, sleep timer (minutes or end of episode), resumes where you stopped, lock-screen and AirPods controls.
- **Downloads:** keep episodes or Drive tracks on the phone for listening without internet. Episodes are deleted after they finish (can be turned off in Settings).
- **Music from Google Drive:** every Drive folder that has audio shows up. "Play" on a folder resumes at the first unfinished track, so a multi-part audiobook picks up where you left off.

## Sync between laptop and phone (free)
Shows, played marks, playback positions, Up Next, the current episode, and the Google/proxy settings sync between every device where sync is turned on. Downloads stay on each device.

Sync is stored in one **private (secret) GitHub gist** in your account (`podplayer-sync.json`). Each device uses its own GitHub key. On **each** device (laptop browser, iPhone app):
1. Podplayer → **Settings** → **Sync between devices** → **Create a GitHub key**. GitHub opens a "New personal access token (classic)" page with only the **gist** box checked.
2. Set **Expiration** to **No expiration**, tap **Generate token**, and copy the `ghp_…` key.
3. Paste it into Podplayer and tap **Connect**.

The app syncs when it opens, a few seconds after each change, when you switch back to it, and every 2 minutes while it's on screen. If the same thing changed on two devices, the newer change wins. A key can be revoked anytime at https://github.com/settings/tokens; it can only read and write gists.

## One-time setup for Drive music (free)
1. Go to https://console.cloud.google.com/ and sign in with your Google account.
2. Create a project (any name, e.g. "Podplayer").
3. **APIs & Services → Library**: enable **Google Drive API**.
4. **APIs & Services → OAuth consent screen** (Google Auth Platform): User type **External**, app name "Podplayer", your email for support/contact. Leave it in **Testing** and add your own address under **Test users**.
5. **Data access / Scopes**: add `https://www.googleapis.com/auth/drive.readonly`.
6. **Clients → Create client** → **Web application**:
   - Authorized JavaScript origins: `https://robrice.github.io`
   - Authorized redirect URIs: `https://robrice.github.io/podplayer/`
7. Copy the **Client ID** (ends in `.apps.googleusercontent.com`) into Podplayer → **Settings** → Google client ID → **Save**, then **Music → Sign in**.

Google will say the app "hasn't been verified". That's expected for a personal app in Testing; choose Continue. Sign-in lasts about an hour, then the app asks again. Downloaded tracks play without signing in.

## Shows whose servers block web apps (e.g. NPR)
Some podcast servers block web apps from reading their feed. Podplayer handles most of them on its own:
1. **Tracking links:** many feed addresses wrap the real one (for example `rss.pdrl.fm/…/feeds.megaphone.fm/…`); the app tries the inner address.
2. **Feed mirror (free, GitHub):** a GitHub Actions job (`.github/workflows/pages.yml`, `tools/mirror.py`) copies blocked feeds into this site every 30 minutes, where the app can always read them. Feeds listed in `mirror/feeds.txt` are always mirrored. If you add a show that still won't load, the app offers **Request mirror**. That opens a pre-filled GitHub issue (`mirror: <feed url>`); submit it, and the show is mirrored within about 2 minutes. The job comments on the issue when it's done. Close the issue to stop mirroring that show.
3. **Public relay:** as a last resort the app tries a free public relay (allorigins.win), which is often slow.

The mirror is public: anyone can see which feeds are listed (only the blocked ones are).

### Optional: your own proxy (Google Apps Script)
Instead of the mirror you can run a private proxy under your Google account:
1. Open https://script.google.com/ → **New project**, paste `apps-script/FeedProxy.gs`, save.
2. **Deploy → New deployment → Web app**: Execute as **Me**, Who has access **Anyone** → Deploy, authorize.
3. Copy the `/exec` URL into Podplayer → **Settings** → Feed proxy URL → **Save**.

The proxy only passes feed text (never audio) and runs under your Google account's free quota.

## Limits
- No CarPlay. iOS may stop playback if another app starts audio.
- New episodes are fetched when the app is opened (iOS doesn't let web apps run in the background).
- Some shows don't allow downloads; they still stream.

## Development
Plain HTML/CSS/JS, no build step. Run locally with `python3 -m http.server 8790` and open http://localhost:8790/. `test/parser.html` checks feed parsing against live feeds.
