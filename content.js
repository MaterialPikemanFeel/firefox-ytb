(() => {
  "use strict";

  // --- Tunable thresholds -------------------------------------------------
  const MIN_REWIND_SECONDS = 1; // ignore tiny backward seeks (quality switches, internal corrections)
  const CONTINUOUS_REWIND_MS = 3000; // rewinds within this window count as one segment
  const BUTTON_VISIBLE_MS = 5000; // how long the armed button stays before fading out
  const PAUSE_EPSILON = 0.25; // tolerance when comparing currentTime to the terminus

  // --- State --------------------------------------------------------------
  let terminus = null; // pre-rewind position (the point we replay up to)
  let replayStart = null; // position captured at first button click
  let monitoring = false; // actively watching to auto-pause at the terminus
  let lastKnownTime = 0; // last observed currentTime, used to detect seek direction
  let lastRewindWallTime = 0; // Date.now() of the previous rewind, for continuity grouping

  let selfInitiatedSeek = false; // suppress detection of seeks we trigger
  let selfInitiatedPlay = false; // suppress dismissal on plays we trigger

  let hideTimer = null;
  let video = null;
  let button = null;

  // --- Button UI ----------------------------------------------------------
  const SVG_NS = "http://www.w3.org/2000/svg";
  const ICON_PATH =
    "M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z";

  function buildIcon() {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", ICON_PATH);
    svg.appendChild(path);
    return svg;
  }

  function ensureButton() {
    if (button && document.contains(button)) return button;
    button = document.getElementById("ytrr-button");
    if (!button) {
      button = document.createElement("button");
      button.id = "ytrr-button";
      button.type = "button";
      button.setAttribute("aria-label", "Replay rewound segment");
      button.appendChild(buildIcon());
      button.addEventListener("click", onButtonClick, true);
    }
    return button;
  }

  function fullscreenRoot() {
    return (
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      null
    );
  }

  function mountButton() {
    const root = fullscreenRoot();
    const btn = ensureButton();
    if (root) {
      if (btn.parentElement !== root) root.appendChild(btn);
    } else if (btn.parentElement) {
      btn.parentElement.removeChild(btn);
    }
  }

  function updateButtonClasses() {
    if (!button) return;
    button.classList.toggle("ytrr-visible", isButtonShown);
    button.classList.toggle("ytrr-monitoring", monitoring);
    const invalid = !monitoring && !hasValidInterval();
    button.classList.toggle("ytrr-disabled", invalid);
  }

  let isButtonShown = false;

  function showButton() {
    if (!fullscreenRoot()) return; // fullscreen-only
    mountButton();
    isButtonShown = true;
    updateButtonClasses();
  }

  function hideButton() {
    isButtonShown = false;
    clearHideTimer();
    updateButtonClasses();
  }

  function clearHideTimer() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function armButtonTemporarily() {
    clearHideTimer();
    showButton();
    hideTimer = setTimeout(() => {
      if (!monitoring) hideButton();
    }, BUTTON_VISIBLE_MS);
  }

  function hasValidInterval() {
    if (terminus === null || !video) return false;
    const start = replayStart !== null ? replayStart : video.currentTime;
    return start < terminus - PAUSE_EPSILON;
  }

  // --- Core interaction ---------------------------------------------------
  function onButtonClick(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!video || terminus === null) return;

    if (!monitoring) {
      // First click: capture the start point and begin monitoring.
      if (!hasValidInterval()) return; // already past the terminus
      replayStart = video.currentTime;
      monitoring = true;
      clearHideTimer();
      showButton();
      selfPlay();
    } else {
      // Subsequent click: jump back to the start and replay the segment.
      if (replayStart === null) return;
      selfSeek(replayStart);
      selfPlay();
    }
    updateButtonClasses();
  }

  function selfSeek(time) {
    if (!video) return;
    selfInitiatedSeek = true;
    video.currentTime = time;
    // The flag is cleared on the next 'seeked' event.
  }

  function selfPlay() {
    if (!video) return;
    selfInitiatedPlay = true;
    const p = video.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
    setTimeout(() => {
      selfInitiatedPlay = false;
    }, 300);
  }

  function dismiss() {
    // Stop monitoring and continue normal playback. Terminus is retained
    // until a new rewind overwrites it or the video changes.
    monitoring = false;
    replayStart = null;
    hideButton();
  }

  // --- Video event handlers ----------------------------------------------
  function onTimeUpdate() {
    if (!video) return;
    const t = video.currentTime;

    if (monitoring && terminus !== null && t >= terminus - PAUSE_EPSILON) {
      if (!video.paused) {
        selfInitiatedSeek = false;
        video.pause();
      }
    }

    if (isButtonShown && !monitoring) updateButtonClasses();

    lastKnownTime = t;
  }

  function onSeeking() {
    if (!video) return;
    if (selfInitiatedSeek) return; // ignore replay jumps we triggered

    const from = lastKnownTime;
    const to = video.currentTime;
    const delta = from - to;

    if (delta >= MIN_REWIND_SECONDS) {
      recordRewind(from);
    }
  }

  function onSeeked() {
    selfInitiatedSeek = false;
    if (video) lastKnownTime = video.currentTime;
  }

  function recordRewind(preRewindPos) {
    const now = Date.now();
    const continuous =
      lastRewindWallTime && now - lastRewindWallTime <= CONTINUOUS_REWIND_MS;

    if (!continuous || terminus === null) {
      terminus = preRewindPos;
    }
    lastRewindWallTime = now;

    // A fresh rewind cancels any in-progress replay session.
    monitoring = false;
    replayStart = null;

    armButtonTemporarily();
    updateButtonClasses();
  }

  function onPlay() {
    if (monitoring && !selfInitiatedPlay) {
      // User resumed playback by other means => dismiss the replay session.
      dismiss();
    }
  }

  function resetState() {
    terminus = null;
    replayStart = null;
    monitoring = false;
    lastRewindWallTime = 0;
    hideButton();
  }

  function onEnded() {
    resetState();
  }

  // --- Wiring -------------------------------------------------------------
  function attachToVideo(v) {
    if (!v || v.__ytrrAttached) return;
    v.__ytrrAttached = true;
    video = v;
    lastKnownTime = v.currentTime || 0;
    v.addEventListener("timeupdate", onTimeUpdate);
    v.addEventListener("seeking", onSeeking);
    v.addEventListener("seeked", onSeeked);
    v.addEventListener("play", onPlay);
    v.addEventListener("ended", onEnded);
  }

  function findAndAttach() {
    const v = document.querySelector("video");
    if (v && v !== video) {
      video = v;
    }
    if (v) attachToVideo(v);
  }

  function onFullscreenChange() {
    if (fullscreenRoot()) {
      mountButton();
      // Do not auto-show on entering fullscreen; only a rewind shows it.
      updateButtonClasses();
    } else {
      hideButton();
    }
  }

  function onNavigate() {
    resetState();
    // The <video> element may be replaced after navigation.
    setTimeout(findAndAttach, 0);
  }

  function init() {
    ensureButton();
    findAndAttach();

    document.addEventListener("fullscreenchange", onFullscreenChange, true);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange, true);
    document.addEventListener("yt-navigate-finish", onNavigate, true);

    // Fallback for navigations / late-loading players: watch the DOM for a
    // new video element and reattach.
    const observer = new MutationObserver(() => {
      findAndAttach();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
