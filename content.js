(() => {
  "use strict";

  // --- Settings (persisted via browser.storage.local) ---------------------
  var DEFAULTS = {
    fadeSeconds: 8, // how long the armed (semi-transparent) button stays
    persistent: false, // keep the button until the next rewind / dismiss
    debug: false, // show the on-page debug log overlay
  };
  var settings = {
    fadeSeconds: DEFAULTS.fadeSeconds,
    persistent: DEFAULTS.persistent,
    debug: DEFAULTS.debug,
  };

  // --- Debug overlay -------------------------------------------------------
  var debugEl = null;
  var debugLines = [];
  function dbg(msg) {
    if (!settings.debug) return;
    var ts = new Date().toLocaleTimeString();
    debugLines.push("[" + ts + "] " + msg);
    if (debugLines.length > 15) debugLines.shift();
    if (!debugEl) {
      debugEl = document.createElement("div");
      debugEl.id = "ytrr-debug";
      debugEl.style.cssText =
        "position:fixed!important;bottom:0!important;left:0!important;right:0!important;" +
        "background:rgba(0,0,0,0.85)!important;color:#0f0!important;font:11px/1.4 monospace!important;" +
        "padding:6px 8px!important;z-index:2147483647!important;max-height:35vh!important;" +
        "overflow-y:auto!important;pointer-events:none!important;white-space:pre-wrap!important;";
      var target = document.body || document.documentElement;
      target.appendChild(debugEl);
    }
    debugEl.textContent = debugLines.join("\n");
  }

  function removeDebugOverlay() {
    if (debugEl && debugEl.parentElement) debugEl.parentElement.removeChild(debugEl);
    debugEl = null;
    debugLines = [];
  }

  function applySettings(loaded) {
    if (loaded && typeof loaded === "object") {
      if (typeof loaded.fadeSeconds === "number" && loaded.fadeSeconds >= 1) {
        settings.fadeSeconds = loaded.fadeSeconds;
      }
      if (typeof loaded.persistent === "boolean") settings.persistent = loaded.persistent;
      if (typeof loaded.debug === "boolean") settings.debug = loaded.debug;
    }
    if (!settings.debug) removeDebugOverlay();
  }

  function loadSettings() {
    try {
      if (typeof browser !== "undefined" && browser.storage && browser.storage.local) {
        browser.storage.local.get(DEFAULTS).then(function (res) {
          applySettings(res);
          dbg("Settings loaded: fade=" + settings.fadeSeconds + "s persistent=" + settings.persistent);
        }, function () {});
        if (browser.storage.onChanged) {
          browser.storage.onChanged.addListener(function (changes, area) {
            if (area !== "local") return;
            var next = {};
            for (var k in changes) next[k] = changes[k].newValue;
            applySettings(next);
            dbg("Settings updated: fade=" + settings.fadeSeconds + "s persistent=" + settings.persistent);
          });
        }
      }
    } catch (e) {}
  }

  // --- Tunable thresholds -------------------------------------------------
  var MIN_REWIND_SECONDS = 1;
  var CONTINUOUS_REWIND_MS = 3000;
  var PAUSE_EPSILON = 0.25;

  // --- State --------------------------------------------------------------
  var terminus = null;
  var replayStart = null;
  var monitoring = false;
  var lastKnownTime = 0;
  var lastRewindWallTime = 0;
  var selfInitiatedSeek = false;
  var lastSelfPlayTime = 0; // wall-clock time of our last programmatic play()
  var lastSelfSeekTime = 0; // wall-clock time of our last programmatic seek()
  var selfSeekClearTimer = null; // fallback timer to clear selfInitiatedSeek
  var reachedTerminus = false; // we already auto-paused at terminus this run
  var SELF_PLAY_GRACE_MS = 3000; // tolerate slow mobile play events
  var SELF_SEEK_GRACE_MS = 1500; // ignore poll-detected jumps right after our seek
  var hideTimer = null;
  var video = null;
  var button = null;
  var isButtonShown = false;
  var pollTimer = null;
  var lastTouchTime = 0;
  var monitorTimer = null;
  var polledTime = 0; // last currentTime seen by the polling monitor
  var lastLogTime = 0; // throttle periodic heartbeat logging
  var MONITOR_INTERVAL_MS = 250;

  // --- Button UI ----------------------------------------------------------
  var SVG_NS = "http://www.w3.org/2000/svg";
  var ICON_PATH =
    "M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z";

  function buildIcon() {
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "26");
    svg.setAttribute("height", "26");
    svg.style.cssText = "fill:currentColor!important;pointer-events:none!important;";
    var path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", ICON_PATH);
    svg.appendChild(path);
    return svg;
  }

  var longPressTimer = null;
  var longPressFired = false;
  function startLongPress() {
    longPressFired = false;
    if (longPressTimer) clearTimeout(longPressTimer);
    longPressTimer = setTimeout(function () {
      longPressFired = true;
      longPressTimer = null;
      dbg("Long-press: dismiss");
      dismiss();
    }, 600);
  }
  function cancelLongPress() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  function onButtonInteraction(event) {
    // Press-and-hold to dismiss the button entirely.
    if (event.type === "touchstart" || event.type === "mousedown") {
      startLongPress();
      return;
    }
    cancelLongPress();
    // Prevent double-firing from touch + click on mobile
    if (event.type === "touchend") {
      lastTouchTime = Date.now();
      event.preventDefault();
    }
    if (event.type === "click" && Date.now() - lastTouchTime < 500) {
      return; // skip click if touchend just fired
    }
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (longPressFired) {
      // The hold already dismissed; swallow the trailing tap.
      longPressFired = false;
      return;
    }
    onButtonClick();
  }

  function ensureButton() {
    if (button && document.contains(button)) return button;
    button = document.getElementById("ytrr-button");
    if (!button) {
      button = document.createElement("div");
      button.id = "ytrr-button";
      button.setAttribute("role", "button");
      button.setAttribute("aria-label", "Replay rewound segment");
      // Inline all styles directly so they work regardless of CSS injection
      button.style.cssText =
        "position:fixed!important;top:16px!important;left:16px!important;" +
        "width:52px!important;height:52px!important;border:none!important;" +
        "border-radius:50%!important;margin:0!important;padding:0!important;" +
        "display:none!important;align-items:center!important;justify-content:center!important;" +
        "background:rgba(0,0,0,0.6)!important;color:#fff!important;" +
        "cursor:pointer!important;z-index:2147483647!important;opacity:0!important;" +
        "transition:opacity 0.25s ease,background-color 0.2s ease!important;" +
        "-webkit-tap-highlight-color:transparent!important;" +
        "box-shadow:0 2px 8px rgba(0,0,0,0.6)!important;touch-action:manipulation!important;" +
        "pointer-events:auto!important;min-width:52px!important;min-height:52px!important;" +
        "line-height:1!important;font-size:0!important;overflow:hidden!important;";
      button.appendChild(buildIcon());
      button.addEventListener("click", onButtonInteraction, true);
      button.addEventListener("touchstart", onButtonInteraction, true);
      button.addEventListener("touchend", onButtonInteraction, true);
      button.addEventListener("mousedown", onButtonInteraction, true);
      button.addEventListener("touchcancel", cancelLongPress, true);
    }
    return button;
  }

  function fullscreenElement() {
    return (
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement ||
      null
    );
  }

  function mountButton() {
    var btn = ensureButton();
    // When an element is fullscreen, only it + its descendants render in the
    // top layer. A button on <body> would be hidden, so mount it INSIDE the
    // fullscreen element. <video> cannot hold rendered children, so fall back
    // to its parent in that case.
    var fsRoot = fullscreenElement();
    var target;
    if (fsRoot) {
      target = fsRoot.tagName === "VIDEO" ? fsRoot.parentElement || fsRoot : fsRoot;
    } else {
      target = document.body || document.documentElement;
    }
    if (target && btn.parentElement !== target) {
      target.appendChild(btn);
      dbg("Button mounted to " + target.tagName + (fsRoot ? " [FS]" : ""));
    }
  }

  function updateButtonVisual() {
    if (!button) return;
    if (isButtonShown) {
      if (monitoring) {
        button.style.display = "flex";
        button.style.opacity = "1";
        button.style.background = "rgba(29,122,252,0.9)";
      } else if (hasValidInterval()) {
        button.style.display = "flex";
        button.style.opacity = "0.85";
        button.style.background = "rgba(0,0,0,0.6)";
      } else {
        button.style.display = "flex";
        button.style.opacity = "0.35";
        button.style.background = "rgba(0,0,0,0.6)";
      }
    } else {
      button.style.display = "none";
      button.style.opacity = "0";
    }
  }

  function showButton() {
    mountButton();
    isButtonShown = true;
    updateButtonVisual();
    dbg("Button shown");
  }

  function hideButton() {
    isButtonShown = false;
    clearHideTimer();
    updateButtonVisual();
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
    if (settings.persistent) return; // stay visible until next rewind / dismiss
    hideTimer = setTimeout(function () {
      if (!monitoring) hideButton();
    }, settings.fadeSeconds * 1000);
  }

  function hasValidInterval() {
    if (terminus === null || !video) return false;
    var start = replayStart !== null ? replayStart : video.currentTime;
    return start < terminus - PAUSE_EPSILON;
  }

  // --- Core interaction ---------------------------------------------------
  function onButtonClick() {
    if (!video || terminus === null) return;
    dbg("Button clicked. monitoring=" + monitoring + " valid=" + hasValidInterval());

    if (!monitoring) {
      if (!hasValidInterval()) return;
      replayStart = video.currentTime;
      monitoring = true;
      reachedTerminus = false;
      clearHideTimer();
      showButton();
      selfPlay();
      dbg("Monitoring started. replay " + replayStart.toFixed(1) + " -> " + terminus.toFixed(1));
    } else {
      if (replayStart === null) return;
      dbg("Replaying from " + replayStart.toFixed(1));
      reachedTerminus = false;
      selfSeek(replayStart);
      selfPlay();
    }
    updateButtonVisual();
  }

  function selfSeek(time) {
    if (!video) return;
    selfInitiatedSeek = true;
    lastSelfSeekTime = Date.now();
    video.currentTime = time;
    // Keep the poll-monitor baselines in sync so our own backward jump is not
    // mistaken for a user rewind by the polling detector.
    polledTime = time;
    lastKnownTime = time;
    // Fallback: if the `seeked` event never fires (unreliable on mobile),
    // clear the flag anyway so future user rewinds are not silently ignored.
    if (selfSeekClearTimer) clearTimeout(selfSeekClearTimer);
    selfSeekClearTimer = setTimeout(function () {
      selfInitiatedSeek = false;
      selfSeekClearTimer = null;
    }, SELF_SEEK_GRACE_MS);
  }

  function selfPlay() {
    if (!video) return;
    lastSelfPlayTime = Date.now();
    try {
      var p = video.play();
      if (p && typeof p.catch === "function") p.catch(function () {});
    } catch (e) {
      dbg("play() error: " + e.message);
    }
  }

  function dismiss() {
    monitoring = false;
    replayStart = null;
    reachedTerminus = false;
    hideButton();
    dbg("Dismissed");
  }

  // --- Video event handlers ----------------------------------------------
  function onTimeUpdate() {
    if (!video) return;
    var t = video.currentTime;

    if (monitoring && !reachedTerminus && terminus !== null && t >= terminus - PAUSE_EPSILON) {
      if (!video.paused) {
        reachedTerminus = true;
        selfInitiatedSeek = false;
        video.pause();
        dbg("Auto-paused at " + t.toFixed(1) + " (terminus=" + terminus.toFixed(1) + ")");
      }
    }

    if (isButtonShown && !monitoring) updateButtonVisual();
    lastKnownTime = t;
  }

  function onSeeking() {
    if (!video) return;
    if (selfInitiatedSeek) return;

    var from = lastKnownTime;
    var to = video.currentTime;
    var delta = from - to;

    dbg("Seek: " + from.toFixed(1) + " -> " + to.toFixed(1) + " (d=" + delta.toFixed(1) + ")");

    if (delta >= MIN_REWIND_SECONDS) {
      dbg("Rewind! terminus=" + from.toFixed(1));
      recordRewind(from);
    }
  }

  function onSeeked() {
    selfInitiatedSeek = false;
    if (video) lastKnownTime = video.currentTime;
  }

  function recordRewind(preRewindPos) {
    var now = Date.now();
    var continuous =
      lastRewindWallTime && now - lastRewindWallTime <= CONTINUOUS_REWIND_MS;

    if (!continuous || terminus === null) {
      terminus = preRewindPos;
    }
    lastRewindWallTime = now;
    monitoring = false;
    replayStart = null;
    reachedTerminus = false;
    armButtonTemporarily();
    updateButtonVisual();
  }

  function onPlay() {
    // A play event soon after our own programmatic play() is ours, not a
    // manual resume. Mobile YouTube can deliver this event seconds late, so
    // use a generous grace window instead of a fixed short timeout.
    if (monitoring && Date.now() - lastSelfPlayTime > SELF_PLAY_GRACE_MS) {
      dismiss();
    }
  }

  function resetState() {
    terminus = null;
    replayStart = null;
    monitoring = false;
    reachedTerminus = false;
    lastRewindWallTime = 0;
    hideButton();
  }

  function onEnded() {
    resetState();
  }

  // --- Video element discovery --------------------------------------------
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
    if (video && video !== v) detachFromVideo(video);
    v.__ytrrAttached = true;
    video = v;
    lastKnownTime = v.currentTime || 0;
    polledTime = v.currentTime || 0;
    v.addEventListener("timeupdate", onTimeUpdate);
    v.addEventListener("seeking", onSeeking);
    v.addEventListener("seeked", onSeeked);
    v.addEventListener("play", onPlay);
    v.addEventListener("ended", onEnded);
    dbg("Attached to video. currentTime=" + v.currentTime.toFixed(1));
  }

  // --- Polling-based rewind detector --------------------------------------
  // Mobile YouTube may not fire standard `seeking` events on rewind, so we
  // also detect backward jumps by polling currentTime directly.
  function monitorTick() {
    // Catch SPA navigations that mobile YouTube performs without firing
    // pushState / popstate / yt-navigate-finish. Polling the URL here ensures
    // leaving the video reliably clears state (and hides the blue button).
    checkUrlChange();

    // Re-pick the actively-playing video if our current one looks stale
    pickActiveVideo();

    // If we were monitoring but the video element is gone from the document
    // (e.g. the player was torn down on navigation), end the session so the
    // button does not linger forever.
    if ((monitoring || isButtonShown) && video && !document.contains(video)) {
      dbg("Video detached from DOM; resetting");
      resetState();
    }
    if (!video) return;

    var t = video.currentTime;

    // Heartbeat log every ~4s so the user can confirm tracking works
    var now = Date.now();
    if (now - lastLogTime > 4000) {
      lastLogTime = now;
      dbg("tick t=" + t.toFixed(1) + " paused=" + video.paused + " term=" + (terminus === null ? "-" : terminus.toFixed(1)));
    }

    // Auto-pause at terminus while monitoring (only once per replay run, so a
    // user resuming past the terminus is not repeatedly re-paused).
    if (monitoring && !reachedTerminus && terminus !== null && t >= terminus - PAUSE_EPSILON) {
      if (!video.paused) {
        reachedTerminus = true;
        selfInitiatedSeek = false;
        video.pause();
        dbg("Auto-paused at " + t.toFixed(1));
      }
    }

    // Detect a backward jump (rewind) that the seeking event may have missed.
    // Skip jumps caused by our own programmatic seeks (replay).
    if (!selfInitiatedSeek && now - lastSelfSeekTime > SELF_SEEK_GRACE_MS) {
      var delta = polledTime - t;
      if (delta >= MIN_REWIND_SECONDS) {
        dbg("Rewind via poll! " + polledTime.toFixed(1) + " -> " + t.toFixed(1));
        recordRewind(polledTime);
      }
    }

    if (isButtonShown && !monitoring) updateButtonVisual();
    polledTime = t;
  }

  function pickActiveVideo() {
    // If current video is playing and advancing, keep it.
    if (video && document.contains(video) && (!video.paused || video.currentTime > 0)) {
      return;
    }
    var vids = deepQuerySelectorAll(document, "video");
    var best = null;
    for (var i = 0; i < vids.length; i++) {
      var cand = vids[i];
      if (!best) { best = cand; continue; }
      // Prefer a video that is playing or has progressed further
      if ((!cand.paused && best.paused) || cand.currentTime > best.currentTime) {
        best = cand;
      }
    }
    if (best && best !== video) {
      attachToVideo(best);
    }
  }

  function startMonitor() {
    if (monitorTimer) return;
    monitorTimer = setInterval(monitorTick, MONITOR_INTERVAL_MS);
  }

  // Deep search: traverse shadow DOMs to find video elements
  function deepQuerySelector(root, selector) {
    var result = root.querySelector(selector);
    if (result) return result;
    // Search in shadow roots
    var all = root.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
      if (all[i].shadowRoot) {
        result = deepQuerySelector(all[i].shadowRoot, selector);
        if (result) return result;
      }
    }
    return null;
  }

  function deepQuerySelectorAll(root, selector) {
    var results = Array.from(root.querySelectorAll(selector));
    var all = root.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
      if (all[i].shadowRoot) {
        results = results.concat(deepQuerySelectorAll(all[i].shadowRoot, selector));
      }
    }
    return results;
  }

  function findAndAttach() {
    // Standard selectors first
    var v =
      document.querySelector("video.html5-main-video") ||
      document.querySelector("#movie_player video") ||
      document.querySelector("ytm-player video") ||
      document.querySelector(".player-container video") ||
      document.querySelector("#player video") ||
      document.querySelector("video");

    if (!v) {
      // Try deep search through shadow DOM
      v = deepQuerySelector(document, "video");
    }

    if (v) {
      if (!v.__ytrrAttached) {
        dbg("Video found: " + (v.src || v.currentSrc || "(blob)").substring(0, 50));
      }
      attachToVideo(v);
      // Stop polling once video is found
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    } else {
      var allVideos = deepQuerySelectorAll(document, "video");
      dbg("No video yet. Deep search found " + allVideos.length + " <video> elements");
    }
  }

  // --- Navigation detection -----------------------------------------------
  function currentVideoId() {
    try {
      var m = location.href.match(/[?&]v=([^&]+)/);
      if (m) return m[1];
      m = location.pathname.match(/\/(?:shorts|embed)\/([^/?]+)/);
      if (m) return m[1];
    } catch (e) {}
    return null;
  }

  function onNavigate() {
    var id = currentVideoId();
    // Only treat as a real navigation when the video actually changed.
    // Mobile YouTube frequently rewrites the URL / fires navigate events
    // during normal playback, which must NOT clear our state.
    if (id === lastVideoId) return;
    dbg("Navigate: video changed " + lastVideoId + " -> " + id);
    lastVideoId = id;
    resetState();
    startPolling();
  }

  var lastUrl = location.href;
  var lastVideoId = currentVideoId();
  function checkUrlChange() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      onNavigate();
    }
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    var attempts = 0;
    pollTimer = setInterval(function () {
      findAndAttach();
      attempts++;
      if (attempts > 15 || (video && video.__ytrrAttached)) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }, 1000);
  }

  // --- Init ---------------------------------------------------------------
  function init() {
    loadSettings();
    dbg("init() URL=" + location.href.substring(0, 70));
    dbg("readyState=" + document.readyState + " body=" + (document.body ? "yes" : "no"));

    ensureButton();
    findAndAttach();

    // Fullscreen change events
    function onFsChange() {
      dbg("fullscreenchange -> " + (fullscreenElement() ? fullscreenElement().tagName : "none"));
      if (isButtonShown) mountButton();
      updateButtonVisual();
    }
    document.addEventListener("fullscreenchange", onFsChange, true);
    document.addEventListener("webkitfullscreenchange", onFsChange, true);
    document.addEventListener("mozfullscreenchange", onFsChange, true);

    // YouTube SPA navigation
    document.addEventListener("yt-navigate-finish", onNavigate, true);
    window.addEventListener("popstate", checkUrlChange, true);

    // Intercept history methods
    var origPush = history.pushState;
    history.pushState = function () {
      origPush.apply(this, arguments);
      checkUrlChange();
    };
    var origReplace = history.replaceState;
    history.replaceState = function () {
      origReplace.apply(this, arguments);
      checkUrlChange();
    };

    // MutationObserver for dynamically added video elements
    var observer = new MutationObserver(function () {
      if (!video || !video.__ytrrAttached) {
        findAndAttach();
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    // Periodic polling for video (covers late-loading players)
    startPolling();

    // Continuous monitor: rewind detection via currentTime polling + auto-pause
    startMonitor();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
