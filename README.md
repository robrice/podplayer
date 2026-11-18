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

## Optional: feed proxy for shows that won't load (e.g. NPR)
Some podcast servers block web apps from reading their feed. To add those shows:
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
