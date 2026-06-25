(() => {
  "use strict";

  // --- Debug overlay -------------------------------------------------------
  const DEBUG = true;
  let debugEl = null;
  const debugLines = [];
  function dbg(msg) {
    if (!DEBUG) return;
    const ts = new Date().toLocaleTimeString();
    debugLines.push(`[${ts}] ${msg}`);
    if (debugLines.length > 12) debugLines.shift();
    if (!debugEl) {
      debugEl = document.createElement("div");
      debugEl.id = "ytrr-debug";
      debugEl.style.cssText =
        "position:fixed!important;bottom:0!important;left:0!important;right:0!important;" +
        "background:rgba(0,0,0,0.85)!important;color:#0f0!important;font:11px/1.4 monospace!important;" +
        "padding:6px 8px!important;z-index:2147483647!important;max-height:40vh!important;" +
        "overflow-y:auto!important;pointer-events:none!important;white-space:pre-wrap!important;";
      (document.body || document.documentElement).appendChild(debugEl);
    }
    debugEl.textContent = debugLines.join("\n");
  }
  dbg("YTRR content script loaded");

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
      button.addEventListener("touchend", onButtonClick, true);
    }
    return button;
  }

  // --- Player container detection -----------------------------------------
  function findPlayerContainer() {
    // Try multiple selectors for both desktop and mobile YouTube
    const selectors = [
      "#movie_player",                    // desktop
      ".html5-video-player",              // desktop fallback
      "#player-container-id",             // mobile m.youtube.com
      ".player-container",                // mobile fallback
      "ytm-player",                       // mobile web component
      ".ytm-autonav-bar-button-renderer", // mobile
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    // Last resort: use the video element's closest positioned ancestor
    if (video && video.parentElement) {
      return video.parentElement;
    }
    return null;
  }

  function isFullscreen() {
    // Standard Fullscreen API
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      return true;
    }
    // YouTube desktop player fullscreen class
    const player = document.querySelector("#movie_player");
    if (player && player.classList.contains("ytp-fullscreen")) {
      return true;
    }
    // Mobile YouTube: check if html/body has fullscreen-related attributes
    const html = document.documentElement;
    if (html.getAttribute("fullscreen") !== null) {
      return true;
    }
    // Detect Android fullscreen via viewport heuristic: if window fills screen
    if (
      window.innerHeight === screen.height ||
      window.innerHeight >= screen.height - 30
    ) {
      return true;
    }
    return false;
  }

  function mountButton() {
    const btn = ensureButton();
    // Try to mount inside fullscreen element first (works on desktop)
    const fsRoot = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsRoot) {
      if (btn.parentElement !== fsRoot) fsRoot.appendChild(btn);
      return;
    }
    // Otherwise mount inside the player container
    const container = findPlayerContainer();
    if (container) {
      // Ensure the container has position for absolute positioning of button
      const pos = getComputedStyle(container).position;
      if (pos === "static") container.style.position = "relative";
      if (btn.parentElement !== container) container.appendChild(btn);
      return;
    }
    // Fallback: append to body
    if (btn.parentElement !== document.body) document.body.appendChild(btn);
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
    mountButton();
    isButtonShown = true;
    updateButtonClasses();
    dbg("Button shown. Parent=" + (button ? (button.parentElement ? button.parentElement.tagName + "#" + (button.parentElement.id || "") : "none") : "no btn"));
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
    event.stopImmediatePropagation();
    if (!video || terminus === null) return;

    if (!monitoring) {
      if (!hasValidInterval()) return;
      replayStart = video.currentTime;
      monitoring = true;
      clearHideTimer();
      showButton();
      selfPlay();
    } else {
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
  }

  function selfPlay() {
    if (!video) return;
    selfInitiatedPlay = true;
    const p = video.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
    setTimeout(() => {
      selfInitiatedPlay = false;
    }, 500);
  }

  function dismiss() {
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
    if (selfInitiatedSeek) return;

    const from = lastKnownTime;
    const to = video.currentTime;
    const delta = from - to;

    dbg(`Seek detected: from=${from.toFixed(1)} to=${to.toFixed(1)} delta=${delta.toFixed(1)}`);

    if (delta >= MIN_REWIND_SECONDS) {
      dbg(`Rewind recorded! terminus=${from.toFixed(1)}`);
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

    monitoring = false;
    replayStart = null;

    armButtonTemporarily();
    updateButtonClasses();
  }

  function onPlay() {
    if (monitoring && !selfInitiatedPlay) {
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
  function detachFromVideo(v) {
    if (!v) return;
    v.removeEventListener("timeupdate", onTimeUpdate);
    v.removeEventListener("seeking", onSeeking);
    v.removeEventListener("seeked", onSeeked);
    v.removeEventListener("play", onPlay);
    v.removeEventListener("ended", onEnded);
    v.__ytrrAttached = false;
  }

  function attachToVideo(v) {
    if (!v || v.__ytrrAttached) return;
    // Detach from the old video if switching
    if (video && video !== v) detachFromVideo(video);
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
    // Try multiple ways to find the video element
    const v =
      document.querySelector("video.html5-main-video") ||
      document.querySelector("#movie_player video") ||
      document.querySelector("ytm-player video") ||
      document.querySelector(".player-container video") ||
      document.querySelector("video");
    if (v) {
      dbg("Video found: " + v.tagName + " src=" + (v.src || v.currentSrc || "(none)").substring(0, 60));
      attachToVideo(v);
    } else {
      const allVideos = document.querySelectorAll("video");
      dbg("Video NOT found. <video> elements on page: " + allVideos.length);
      // Log iframe info
      const iframes = document.querySelectorAll("iframe");
      dbg("Iframes on page: " + iframes.length);
    }
  }

  function onFullscreenChange() {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      mountButton();
      updateButtonClasses();
    }
  }

  function onNavigate() {
    resetState();
    setTimeout(findAndAttach, 500);
  }

  // Watch for URL changes (SPA navigation) via popstate and history
  let lastUrl = location.href;
  function checkUrlChange() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      onNavigate();
    }
  }

  function init() {
    dbg("init() called. URL=" + location.href.substring(0, 80));
    dbg("document.readyState=" + document.readyState + " body=" + (document.body ? "yes" : "no"));
    ensureButton();
    findAndAttach();

    document.addEventListener("fullscreenchange", onFullscreenChange, true);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange, true);

    // YouTube SPA navigation events
    document.addEventListener("yt-navigate-finish", onNavigate, true);
    // Mobile YouTube may use different navigation; also listen for popstate
    window.addEventListener("popstate", checkUrlChange, true);

    // Intercept pushState/replaceState for SPA detection
    const origPushState = history.pushState;
    history.pushState = function () {
      origPushState.apply(this, arguments);
      checkUrlChange();
    };
    const origReplaceState = history.replaceState;
    history.replaceState = function () {
      origReplaceState.apply(this, arguments);
      checkUrlChange();
    };

    // Watch DOM for new video elements (lazy-loaded players)
    const observer = new MutationObserver(() => {
      findAndAttach();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    // Retry finding video in case it loads late
    setTimeout(findAndAttach, 1000);
    setTimeout(findAndAttach, 3000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
