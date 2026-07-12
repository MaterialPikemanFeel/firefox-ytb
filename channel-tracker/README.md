# YouTube Channel Tracker (mobile userscript)

A Violentmonkey/Tampermonkey userscript for **Firefox on Android** that builds a
fixed, cached, oldest-to-newest list of a channel's videos on `m.youtube.com`,
showing YouTube's own watched progress and letting you filter to unwatched.

## Why

YouTube's channel page is endless-scroll and stateless. If you want to watch a
channel's whole back catalog oldest-first, you constantly re-scroll and lose
your place. This script scrapes the channel once, caches it locally, and gives
you a static list with native watched markers.

## Install

1. In Firefox Android install **Violentmonkey** (or Tampermonkey).
2. Open the raw script URL and Violentmonkey will offer to install it:
   `channel-tracker/yt-channel-tracker.user.js`
3. Stay logged into YouTube (the red watched-progress bar requires login).

## Use

1. Open a channel's page on `m.youtube.com` (e.g. `m.youtube.com/@channel/videos`).
2. Tap the red **List** button (bottom-right).
3. First time: confirm **Scan**. It auto-scrolls and collects every video
   (progress shown, **Stop** to cancel — partial results are kept).
4. A full-screen list opens: native thumbnail + red progress bar, title,
   duration. Default order **oldest → newest**.
5. Toolbar: toggle sort, cycle filter (All / Unwatched / Watched), **Rescan**.
6. Tap a row to open that video in a **new tab**.

Next time you tap **List** it asks whether to **Update** (incremental: scroll
from the top until it hits already-cached videos) or **Skip** (open the cache
instantly).

### Hub (overview of all channels)

Open `https://m.youtube.com/?ytct=hub` — bookmark it / pin it to the Firefox
home screen. It shows a card for every cached channel (latest-video cover,
name, video count, unwatched count, last-scanned time). Pick a sort (recently
scanned / name A–Z / most unwatched), tap a card to open that channel's cached
list, and **Close** returns to the hub. The **✕** on a card deletes that
channel's cache. Works offline since everything is read from the local cache.

## Notes / limitations

- Watched state comes purely from YouTube's native resume-playback bar, so it
  reflects your real account history (watched ≥90% = "Watched", ≤5% =
  "Unwatched").
- Mobile YouTube DOM changes over time; selectors may need updating.
- Cache is per-device (local storage), not synced across devices.
- This is independent from the Rewind Replay extension in this repo.
