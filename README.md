# YouTube Rewind Replay

A Firefox extension (built primarily for **Firefox for Android, fullscreen**) that
remembers where you rewound from on YouTube and lets you replay that exact
segment with a single tap.

## What it does

When watching a YouTube video you often rewind to re-watch a bit you missed, but
it is hard to land back on the exact spot you were at. This extension:

1. **Silently records the pre-rewind position.** When you seek backwards, it
   remembers the time you were at *before* rewinding (the *terminus*).
2. **Shows a floating button** in the top-left of the fullscreen player.
3. **Replays the segment on tap.** Tapping the button starts playing from your
   current position and **auto-pauses** when it reaches the terminus.
4. **Repeats on demand.** After it auto-pauses, tap again to jump back to the
   start point and watch the segment once more — as many times as you like.
5. **Dismisses naturally.** Resume playback with YouTube's own play control to
   end the replay session and continue watching normally.

## Behaviour details

- **Fullscreen only.** The button only appears in fullscreen, where it has room
  in the top-left corner for easy one-handed (left thumb) access.
- **Appears on rewind, then fades.** After a rewind the button shows for ~5s and
  fades out. It does not reappear on its own — the next rewind brings it back.
- **Continuous rewinds count as one.** Multiple rewinds within 3 seconds keep the
  original terminus (you are still re-watching the same segment).
- **Tiny seeks are ignored.** Backward seeks under 1 second (quality switches,
  internal time corrections) do not count as rewinds.
- **State resets** when you switch videos or a video ends.

## Installing on Firefox for Android

This is a Manifest V2 extension (requires Firefox / Firefox for Android 142+).
To run it on Firefox for Android you can either:

- Install a signed build from AMO (`addons.mozilla.org`), or
- Use **Firefox Nightly** with a custom add-on collection, or load it via
  `web-ext run --target=firefox-android` during development.

## Development

```bash
npm install --global web-ext
web-ext lint        # validate the extension
web-ext run         # run in a temporary Firefox profile (desktop)
```

## Files

| File           | Purpose                                             |
| -------------- | --------------------------------------------------- |
| `manifest.json`| Extension manifest (MV2, content script).           |
| `content.js`   | Rewind detection, state machine, replay logic.      |
| `content.css`  | Floating button styling.                            |
| `icons/`       | Toolbar / listing icons.                            |
