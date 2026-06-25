// ==UserScript==
// @name         YouTube Channel Tracker (mobile)
// @namespace    https://github.com/MaterialPikemanFeel/firefox-ytb
// @version      0.6.0
// @downloadURL  https://raw.githubusercontent.com/MaterialPikemanFeel/firefox-ytb/devin/1782401112-replay-extension/channel-tracker/yt-channel-tracker.user.js
// @updateURL    https://raw.githubusercontent.com/MaterialPikemanFeel/firefox-ytb/devin/1782401112-replay-extension/channel-tracker/yt-channel-tracker.user.js
// @description  Build a fixed, cached, oldest-to-newest list of a channel's videos on m.youtube.com, showing YouTube's native watched progress and letting you filter unwatched. For Firefox Android + Violentmonkey.
// @author       MaterialPikemanFeel
// @match        https://m.youtube.com/*
// @match        https://www.youtube.com/*
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_openInTab
// @grant        GM.setValue
// @grant        GM.getValue
// @grant        GM.deleteValue
// @grant        GM.listValues
// @grant        GM.openInTab
// @noframes
// ==/UserScript==

/* global GM, GM_setValue, GM_getValue, GM_deleteValue, GM_listValues, GM_openInTab */

(function () {
  "use strict";

  // ---- Small storage shim: works with both GM.* (promise) and GM_* (sync) ---
  var store = {
    get: function (key, def) {
      try {
        if (typeof GM !== "undefined" && GM && GM.getValue) {
          return Promise.resolve(GM.getValue(key, def));
        }
      } catch (e) {}
      try {
        return Promise.resolve(
          typeof GM_getValue === "function" ? GM_getValue(key, def) : def
        );
      } catch (e2) {
        return Promise.resolve(def);
      }
    },
    set: function (key, val) {
      try {
        if (typeof GM !== "undefined" && GM && GM.setValue) {
          return Promise.resolve(GM.setValue(key, val));
        }
      } catch (e) {}
      try {
        if (typeof GM_setValue === "function") GM_setValue(key, val);
      } catch (e2) {}
      return Promise.resolve();
    },
    del: function (key) {
      try {
        if (typeof GM !== "undefined" && GM && GM.deleteValue) {
          return Promise.resolve(GM.deleteValue(key));
        }
      } catch (e) {}
      try {
        if (typeof GM_deleteValue === "function") GM_deleteValue(key);
      } catch (e2) {}
      return Promise.resolve();
    }
  };

  function openTab(url) {
    try {
      if (typeof GM !== "undefined" && GM && GM.openInTab) {
        GM.openInTab(url, { active: false, insert: true });
        return;
      }
    } catch (e) {}
    try {
      if (typeof GM_openInTab === "function") {
        GM_openInTab(url, { active: false, insert: true });
        return;
      }
    } catch (e2) {}
    window.open(url, "_blank");
  }

  // ---- Constants ----------------------------------------------------------
  var PREFIX = "ytct:"; // storage key prefix
  var FAB_ID = "ytct-fab";
  var OVERLAY_ID = "ytct-overlay";
  var SCROLL_STEP_PAUSE_MS = 700; // wait between scroll steps for lazy load
  var SCROLL_SETTLE_ROUNDS = 4; // consecutive no-growth rounds = reached end
  var MAX_SCROLL_ROUNDS = 4000; // hard safety cap

  var sortAsc = true; // oldest -> newest by default
  var filterMode = "all"; // all | unwatched | watched
  var scanning = false;
  var cancelScan = false;
  var currentRec = null; // record backing the currently-open list overlay

  // ---- Channel identity ---------------------------------------------------
  function getChannelKey() {
    // Prefer canonical channel URL meta if present.
    var canonical = document.querySelector('link[rel="canonical"]');
    var href = canonical ? canonical.href : location.href;
    var m =
      href.match(/\/channel\/([A-Za-z0-9_-]+)/) ||
      location.href.match(/\/channel\/([A-Za-z0-9_-]+)/);
    if (m) return "id:" + m[1];
    var h =
      href.match(/\/@([^/?#]+)/) || location.href.match(/\/@([^/?#]+)/);
    if (h) return "handle:" + decodeURIComponent(h[1]);
    var u =
      href.match(/\/(user|c)\/([^/?#]+)/) ||
      location.href.match(/\/(user|c)\/([^/?#]+)/);
    if (u) return "legacy:" + decodeURIComponent(u[2]);
    return null;
  }

  function isChannelPage() {
    var p = location.pathname;
    if (/^\/(channel|c|user)\//.test(p)) return true;
    if (/^\/@[^/]+/.test(p)) return true;
    return false;
  }

  function isVideosTab() {
    // On mobile the videos tab path ends with /videos, but the channel root
    // also lists videos. Accept either; scanning just grabs whatever is there.
    return isChannelPage();
  }

  function channelTitle() {
    var sel = [
      "ytm-channel-header-renderer .channel-title",
      ".channel-title",
      'meta[property="og:title"]'
    ];
    for (var i = 0; i < sel.length; i++) {
      var el = document.querySelector(sel[i]);
      if (el) return el.content || el.textContent.trim();
    }
    if (document.title) return document.title.replace(/ - YouTube.*/, "").trim();
    return "Channel";
  }

  // ---- Scraping -----------------------------------------------------------
  // Extract every video card currently in the DOM. Returns array of
  // { id, title, thumb, duration, progress } (progress 0..100 or null).
  function scrapeVisibleCards() {
    var out = [];
    var seen = {};
    var anchors = document.querySelectorAll('a[href*="/watch?v="]');
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      var idm = a.getAttribute("href").match(/[?&]v=([A-Za-z0-9_-]{11})/);
      if (!idm) continue;
      var id = idm[1];
      if (seen[id]) continue;

      // Walk up to the card container so we can read title/thumb/progress.
      var card = a.closest(
        "ytm-media-item, ytm-video-with-context-renderer, ytm-compact-video-renderer, ytd-grid-video-renderer, ytd-rich-item-renderer, yt-lockup-view-model, li, .compact-media-item"
      ) || a.parentElement;

      var title = extractTitle(a, card);
      if (!title) continue; // skip non-video chrome links

      seen[id] = true;
      var m = measureProgress(card);
      out.push({
        id: id,
        title: title,
        thumb: extractThumb(card, id),
        duration: extractDuration(card),
        progress: m.progress,
        diag: { sel: m.sel, width: m.width, aria: m.aria, ratio: m.ratio, scaleX: m.scaleX, signal: m.signal }
      });
    }
    return out;
  }

  function extractTitle(a, card) {
    // aria-label on the thumbnail link is the most reliable on mobile.
    var t =
      a.getAttribute("aria-label") ||
      (card && qText(card, ".media-item-headline, .yt-core-attributed-string, h3, h4, #video-title, .compact-media-item-headline"));
    if (t) return t.trim();
    // Fallback: title attribute or trimmed text of the anchor.
    return (a.getAttribute("title") || a.textContent || "").trim();
  }

  function qText(root, sel) {
    var el = root.querySelector(sel);
    return el ? (el.textContent || "").trim() : "";
  }

  function extractThumb(card, id) {
    if (card) {
      var img = card.querySelector("img");
      if (img) {
        var src =
          img.getAttribute("src") ||
          img.getAttribute("data-thumb") ||
          img.getAttribute("data-src");
        if (src && /^https?:/.test(src) && src.indexOf("ytimg") !== -1) {
          return src;
        }
      }
    }
    // Deterministic fallback URL from the video id.
    return "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg";
  }

  function extractDuration(card) {
    if (!card) return "";
    var d = card.querySelector(
      ".time-status, ytm-thumbnail-overlay-time-status-renderer, .timestamp, .ytp-time-duration, badge-shape, .badge-shape-wiz__text"
    );
    if (d) {
      var txt = (d.textContent || "").trim();
      var mm = txt.match(/(\d+:)?\d?\d:\d\d/);
      if (mm) return mm[0];
    }
    return "";
  }

  // Read YouTube's native "resume playback" red bar to derive watched %.
  // Mobile YouTube has cycled through several DOM shapes for this bar, so we
  // search broadly: any element under the card whose class/id hints at a
  // resume/progress segment, then read its width from inline style, computed
  // style ratio, or an aria-value.
  function pctFromEl(el) {
    if (!el) return null;
    // 1) Inline style width as a percentage.
    var w = el.style && el.style.width ? el.style.width : "";
    var pm = w.match(/([\d.]+)%/);
    if (pm) return clampPct(parseFloat(pm[1]));
    // 2) ARIA value (progressbar role).
    var av = el.getAttribute && el.getAttribute("aria-valuenow");
    if (av != null && av !== "") {
      var n = parseFloat(av);
      if (!isNaN(n)) return clampPct(n);
    }
    // 3) Computed width relative to parent (handles px / flex / transform).
    try {
      var cs = parseFloat(getComputedStyle(el).width);
      var parent = el.parentElement;
      var pw = parent ? parseFloat(getComputedStyle(parent).width) : 0;
      if (cs && pw && pw > cs * 0.2) return clampPct((cs / pw) * 100);
    } catch (e) {}
    return null;
  }

  function clampPct(n) {
    if (isNaN(n)) return null;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  var PROGRESS_SELECTOR =
    "ytm-thumbnail-overlay-resume-playback-renderer .thumbnail-overlay-resume-playback-progress, " +
    ".thumbnail-overlay-resume-playback-progress, " +
    "#progress, .ytThumbnailOverlayProgressBarHostWatchedProgressBarSegment, " +
    ".ytThumbnailOverlayResumePlaybackRendererProgressBar, " +
    ".ytProgressBarLineProgressBarPlayed, .ytProgressBarPlayheadProgressBarPlayed";

  // Read the scaleX factor from an element's transform (matrix(a,...) or
  // scaleX(a)), used by progress bars that scale a full-width element.
  function scaleXFromEl(el) {
    if (!el) return null;
    try {
      var t = getComputedStyle(el).transform;
      if (!t || t === "none") return null;
      var m = t.match(/matrix\(([^)]+)\)/);
      if (m) {
        var a = parseFloat(m[1].split(",")[0]);
        if (!isNaN(a)) return clampPct(a * 100);
      }
      var sx = t.match(/scaleX\(([\d.]+)\)/);
      if (sx) return clampPct(parseFloat(sx[1]) * 100);
    } catch (e) {}
    return null;
  }

  function extractProgress(card) {
    return measureProgress(card).progress;
  }

  // Compute the watched percentage and capture the raw values each read
  // method produced, so the in-app Debug tool can explain mismatches.
  function measureProgress(card) {
    var diag = { sel: "", width: null, aria: null, ratio: null, scaleX: null, progress: null, signal: false };
    if (!card) return diag;

    var bar = card.querySelector(PROGRESS_SELECTOR);
    var el = bar;
    if (!el) {
      var all = card.querySelectorAll('[class*="rogress"], [class*="esume"], [class*="layed"], [role="progressbar"]');
      for (var i = 0; i < all.length; i++) {
        diag.signal = true;
        if (pctFromEl(all[i]) != null || scaleXFromEl(all[i]) != null) {
          el = all[i];
          break;
        }
      }
      if (!el && all.length) el = all[0];
    }

    if (el) {
      diag.sel = (el.tagName || "").toLowerCase() + (el.className ? "." + String(el.className).replace(/\s+/g, ".") : "");
      var w = el.style && el.style.width ? el.style.width : "";
      var pm = w.match(/([\d.]+)%/);
      if (pm) diag.width = clampPct(parseFloat(pm[1]));
      var av = el.getAttribute && el.getAttribute("aria-valuenow");
      if (av != null && av !== "" && !isNaN(parseFloat(av))) diag.aria = clampPct(parseFloat(av));
      try {
        var cs = parseFloat(getComputedStyle(el).width);
        var pw = el.parentElement ? parseFloat(getComputedStyle(el.parentElement).width) : 0;
        if (cs && pw && pw > cs * 0.2) diag.ratio = clampPct((cs / pw) * 100);
      } catch (e) {}
      diag.scaleX = scaleXFromEl(el);
    }

    // Final decision: prefer the most reliable signals first.
    if (diag.width != null) diag.progress = diag.width;
    else if (diag.aria != null) diag.progress = diag.aria;
    else if (diag.scaleX != null) diag.progress = diag.scaleX;
    else if (diag.ratio != null) diag.progress = diag.ratio;
    else if (diag.signal) diag.progress = 50;
    return diag;
  }

  // Diagnostic: capture the HTML of the first card that has a thumbnail, so we
  // can identify the exact progress-bar markup on this device.
  function captureSampleHtml() {
    var anchors = document.querySelectorAll('a[href*="/watch?v="]');
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      if (!/[?&]v=([A-Za-z0-9_-]{11})/.test(a.getAttribute("href") || "")) continue;
      var card =
        a.closest(
          "ytm-media-item, ytm-video-with-context-renderer, ytm-compact-video-renderer, ytd-grid-video-renderer, ytd-rich-item-renderer, yt-lockup-view-model, li, .compact-media-item"
        ) || a.parentElement;
      if (card) {
        var html = card.outerHTML || "";
        // Trim to keep it pasteable.
        if (html.length > 8000) html = html.slice(0, 8000) + "…[truncated]";
        return html;
      }
    }
    return "(no video card found)";
  }

  // ---- Scan loop ----------------------------------------------------------
  function mergeCards(into, intoIndex, fresh) {
    var added = 0;
    for (var i = 0; i < fresh.length; i++) {
      var c = fresh[i];
      var existing = intoIndex[c.id];
      if (!existing) {
        c.order = into.length; // capture DOM appearance order (newest-first)
        into.push(c);
        intoIndex[c.id] = c;
        added++;
      } else {
        // Refresh volatile fields (progress can change as you watch).
        if (c.progress != null) existing.progress = c.progress;
        if (c.thumb) existing.thumb = c.thumb;
        if (c.duration) existing.duration = c.duration;
        if (c.title) existing.title = c.title;
      }
    }
    return added;
  }

  function scanChannel(opts) {
    opts = opts || {};
    var stopOnKnown = !!opts.incremental;
    var known = opts.known || {};
    return new Promise(function (resolve) {
      var collected = [];
      var index = {};
      var rounds = 0;
      var noGrowth = 0;
      cancelScan = false;
      scanning = true;

      function finish() {
        scanning = false;
        resolve(collected);
      }

      function step() {
        if (cancelScan) return finish();
        var fresh = scrapeVisibleCards();
        var added = mergeCards(collected, index, fresh);

        // Incremental update: once we hit videos we already cached, the new
        // ones above them are all we needed.
        if (stopOnKnown && fresh.length) {
          var hitKnown = false;
          for (var i = 0; i < fresh.length; i++) {
            if (known[fresh[i].id]) {
              hitKnown = true;
              break;
            }
          }
          if (hitKnown && added === 0) return finish();
        }

        updateProgressToast(collected.length);

        if (added === 0) {
          noGrowth++;
        } else {
          noGrowth = 0;
        }

        rounds++;
        if (noGrowth >= SCROLL_SETTLE_ROUNDS || rounds >= MAX_SCROLL_ROUNDS) {
          return finish();
        }

        window.scrollTo(0, document.documentElement.scrollHeight);
        setTimeout(step, SCROLL_STEP_PAUSE_MS);
      }

      step();
    });
  }

  // ---- Persistence --------------------------------------------------------
  function recordKey(chKey) {
    return PREFIX + chKey;
  }

  function loadRecord(chKey) {
    return store.get(recordKey(chKey), null).then(function (raw) {
      if (!raw) return null;
      try {
        return typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch (e) {
        return null;
      }
    });
  }

  function saveRecord(chKey, rec) {
    return store.set(recordKey(chKey), JSON.stringify(rec));
  }

  // ---- UI: floating action button -----------------------------------------
  function ensureFab() {
    if (document.getElementById(FAB_ID)) {
      refreshFabLabel();
      return;
    }
    if (!isVideosTab()) return;
    var fab = document.createElement("button");
    fab.id = FAB_ID;
    fab.type = "button";
    fab.textContent = "List";
    fab.title = "Channel Tracker (long-press for diagnostics)";
    fab.addEventListener("click", onFabClick, true);
    attachLongPress(fab, showSampleOverlay);
    document.documentElement.appendChild(fab);
    refreshFabLabel();
  }

  // Reflect cache state on the FAB: show "Scan" when this channel has no cached
  // list yet, "List" once it does.
  function refreshFabLabel() {
    var fab = document.getElementById(FAB_ID);
    if (!fab) return;
    var chKey = getChannelKey();
    if (!chKey) return;
    loadRecord(chKey).then(function (rec) {
      var f = document.getElementById(FAB_ID);
      if (!f) return;
      var has = rec && rec.videos && rec.videos.length;
      f.textContent = has ? "List" : "Scan";
    });
  }

  // Long-press the FAB (~600ms) to dump a sample card's HTML, independent of
  // the list overlay. Used to diagnose progress-bar markup on a real device.
  function attachLongPress(el, fn) {
    var timer = null;
    var fired = false;
    function start() {
      fired = false;
      timer = setTimeout(function () {
        fired = true;
        fn();
      }, 600);
    }
    function cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    }
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchend", cancel);
    el.addEventListener("touchmove", cancel);
    el.addEventListener("touchcancel", cancel);
    el.addEventListener("mousedown", start);
    el.addEventListener("mouseup", cancel);
    el.addEventListener("mouseleave", cancel);
    // Swallow the click that follows a long-press so it doesn't also scan.
    el.addEventListener(
      "click",
      function (e) {
        if (fired) {
          e.preventDefault();
          e.stopPropagation();
          fired = false;
        }
      },
      true
    );
  }

  function showSampleOverlay() {
    closeOverlay();
    var html = captureSampleHtml();
    var box = document.createElement("div");
    box.id = OVERLAY_ID;
    var hdr = document.createElement("div");
    hdr.className = "ytct-header";
    var t = document.createElement("div");
    t.className = "ytct-title";
    t.textContent = "Sample card HTML";
    var x = mkBtn("Close", function () { closeOverlay(); });
    hdr.appendChild(t);
    hdr.appendChild(x);
    var ta = document.createElement("textarea");
    ta.value = html;
    ta.style.cssText =
      "width:100%;height:62vh;background:#111;color:#0f0;border:0;font-size:11px;white-space:pre;box-sizing:border-box;padding:8px;";
    var bar = document.createElement("div");
    bar.className = "ytct-toolbar";
    bar.appendChild(
      mkBtn("Copy", function () {
        ta.select();
        try { document.execCommand("copy"); } catch (e) {}
        toast("Copied");
      })
    );
    box.appendChild(hdr);
    box.appendChild(bar);
    box.appendChild(ta);
    document.documentElement.appendChild(box);
  }

  // One-tap progress-bar diagnostic: dumps a compact, copyable report of the
  // last ~15 cards in the cached list, showing what each read method produced
  // and the final decision, so watched-% mismatches can be diagnosed remotely.
  function showProgressDiag(rec) {
    closeOverlay();
    // Follow the on-screen order so "last 15" = the bottom of the list the
    // user sees (newest videos under the default oldest->newest sort).
    var vids = orderedVideos((rec && rec.videos) || []);
    var lines = [];
    lines.push("YT Channel Tracker progress diagnostic");
    lines.push("version 0.6.0  channel=" + (rec && rec.channelKey ? rec.channelKey : "?"));
    lines.push("total=" + vids.length + "  scannedAt=" + (rec && rec.scannedAt ? new Date(rec.scannedAt).toISOString() : "?"));
    lines.push("(bottom 15 rows of the list, as displayed)");
    lines.push("columns: progress | width% | aria | ratio% | scaleX% | signal | sel | title");
    lines.push("----------------------------------------");
    var start = Math.max(0, vids.length - 15);
    for (var i = start; i < vids.length; i++) {
      var v = vids[i];
      var d = v.diag || {};
      lines.push(
        "[" + (i + 1) + "] " +
          fmtPct(v.progress) + " | " +
          fmtPct(d.width) + " | " +
          fmtPct(d.aria) + " | " +
          fmtPct(d.ratio) + " | " +
          fmtPct(d.scaleX) + " | " +
          (d.signal ? "Y" : "n") + " | " +
          (d.sel || "-") + " | " +
          String(v.title || "").slice(0, 40)
      );
    }
    if (vids.length === 0) lines.push("(no cached videos — Scan first)");

    var report = lines.join("\n");
    var box = document.createElement("div");
    box.id = OVERLAY_ID;
    box.className = "ytct-overlay";
    var hdr = document.createElement("div");
    hdr.className = "ytct-header";
    var t = document.createElement("div");
    t.className = "ytct-title";
    t.textContent = "Progress diagnostic (last 15)";
    var x = mkBtn("Close", function () { closeOverlay(); });
    hdr.appendChild(t);
    hdr.appendChild(x);
    var ta = document.createElement("textarea");
    ta.value = report;
    ta.readOnly = true;
    ta.style.cssText =
      "width:100%;height:60vh;background:#111;color:#0f0;border:0;font-size:11px;white-space:pre;box-sizing:border-box;padding:8px;";
    var bar = document.createElement("div");
    bar.className = "ytct-toolbar";
    var copyBtn = mkBtn("Copy", function () {
      ta.focus();
      ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) {}
      if (!ok && navigator.clipboard) {
        navigator.clipboard.writeText(report).then(function () {}, function () {});
      }
      copyBtn.textContent = "Copied \u2713";
      toast("Copied");
      setTimeout(function () { copyBtn.textContent = "Copy"; }, 1500);
    });
    bar.appendChild(copyBtn);
    box.appendChild(hdr);
    box.appendChild(bar);
    box.appendChild(ta);
    document.documentElement.appendChild(box);
  }

  function fmtPct(n) {
    return n == null ? "-" : n + "%";
  }

  function removeFab() {
    var f = document.getElementById(FAB_ID);
    if (f) f.remove();
  }

  function onFabClick(e) {
    e.preventDefault();
    e.stopPropagation();
    var chKey = getChannelKey();
    if (!chKey) {
      toast("Open a channel page first");
      return;
    }
    loadRecord(chKey).then(function (rec) {
      if (!rec || !rec.videos || !rec.videos.length) {
        confirmDialog(
          "No cached list for this channel yet. Scan now?",
          "Scan",
          function () {
            runScan(chKey, false);
          }
        );
        return;
      }
      var ago = rec.scannedAt ? timeAgo(rec.scannedAt) : "unknown";
      confirmDialog(
        "Last scan: " +
          ago +
          " (" +
          rec.videos.length +
          " videos). Update before viewing?",
        "Update",
        function () {
          runScan(chKey, true);
        },
        "Skip",
        function () {
          openOverlay(rec);
        }
      );
    });
  }

  function runScan(chKey, incremental) {
    if (scanning) return;
    showProgressToast();
    loadRecord(chKey).then(function (existing) {
      var known = {};
      var base = [];
      if (existing && existing.videos) {
        base = existing.videos.slice();
        for (var i = 0; i < base.length; i++) known[base[i].id] = base[i];
      }
      scanChannel({ incremental: incremental, known: known }).then(function (
        fresh
      ) {
        hideProgressToast();
        if (cancelScan && !fresh.length) {
          toast("Scan cancelled");
          return;
        }
        var rec = mergeIntoRecord(existing, fresh, chKey);
        saveRecord(chKey, rec).then(function () {
          openOverlay(rec);
        });
      });
    });
  }

  function mergeIntoRecord(existing, fresh, chKey) {
    var byId = {};
    var list = [];
    var seq = 0;
    // Fresh scan preserves channel DOM order (newest-first). We assign a
    // monotonically increasing "seq" so newest-first DOM order is recoverable;
    // oldest->newest is just the reverse.
    function push(v) {
      if (byId[v.id]) {
        var ex = byId[v.id];
        if (v.progress != null) ex.progress = v.progress;
        if (v.thumb) ex.thumb = v.thumb;
        if (v.duration) ex.duration = v.duration;
        if (v.title) ex.title = v.title;
        return;
      }
      byId[v.id] = v;
      list.push(v);
    }
    for (var i = 0; i < fresh.length; i++) {
      fresh[i].seq = seq++;
      push(fresh[i]);
    }
    // Keep any previously-cached videos not seen this round (e.g. incremental
    // scan that stopped early) appended after the fresh ones.
    if (existing && existing.videos) {
      for (var j = 0; j < existing.videos.length; j++) {
        var old = existing.videos[j];
        if (!byId[old.id]) {
          old.seq = seq++;
          push(old);
        }
      }
    }
    return {
      channelKey: chKey,
      title: channelTitle(),
      url: location.href.split("?")[0],
      scannedAt: Date.now(),
      videos: list
    };
  }

  // ---- UI: overlay list ----------------------------------------------------
  function openOverlay(rec) {
    closeOverlay();
    currentRec = rec;
    var ov = document.createElement("div");
    ov.id = OVERLAY_ID;

    var header = document.createElement("div");
    header.className = "ytct-header";

    var counts = countWatched(rec.videos);
    var titleEl = document.createElement("div");
    titleEl.className = "ytct-title";
    titleEl.textContent = rec.title || "Channel";

    var stats = document.createElement("div");
    stats.className = "ytct-stats";
    stats.textContent =
      rec.videos.length +
      " videos · watched " +
      counts.watched +
      " / unwatched " +
      counts.unwatched;

    var diagBtn = document.createElement("button");
    diagBtn.className = "ytct-close";
    diagBtn.textContent = "Debug";
    diagBtn.title = "Diagnostic: progress-bar readings";
    diagBtn.addEventListener("click", function () { showProgressDiag(rec); }, true);

    var close = document.createElement("button");
    close.className = "ytct-close";
    close.textContent = "\u2715";
    close.addEventListener("click", closeOverlay, true);

    header.appendChild(titleEl);
    header.appendChild(stats);
    header.appendChild(diagBtn);
    header.appendChild(close);

    var toolbar = document.createElement("div");
    toolbar.className = "ytct-toolbar";

    var sortBtn = mkBtn(sortAsc ? "Oldest \u2192 Newest" : "Newest \u2192 Oldest", function () {
      sortAsc = !sortAsc;
      sortBtn.textContent = sortAsc ? "Oldest \u2192 Newest" : "Newest \u2192 Oldest";
      renderList(listWrap, rec.videos);
    });

    var filtBtn = mkBtn(filterLabel(), function () {
      filterMode =
        filterMode === "all"
          ? "unwatched"
          : filterMode === "unwatched"
          ? "watched"
          : "all";
      filtBtn.textContent = filterLabel();
      renderList(listWrap, rec.videos);
    });

    var rescanBtn = mkBtn("Rescan", function () {
      closeOverlay();
      runScan(rec.channelKey, false);
    });

    // Diagnostic: dump a sample card's HTML into a textarea so the user can
    // copy it and send it back. Helps identify the device's progress markup.
    var sampleBtn = mkBtn("Sample", function () {
      closeOverlay();
      var html = captureSampleHtml();
      var box = document.createElement("div");
      box.id = OVERLAY_ID;
      box.className = "ytct-overlay";
      box.innerHTML =
        '<div class="ytct-header"><span>Sample card HTML</span></div>';
      var ta = document.createElement("textarea");
      ta.value = html;
      ta.style.cssText =
        "width:100%;height:60vh;background:#111;color:#0f0;border:0;font-size:11px;white-space:pre;";
      var copyBtn = mkBtn("Copy", function () {
        ta.select();
        try { document.execCommand("copy"); } catch (e) {}
      });
      var backBtn = mkBtn("Close", function () { closeOverlay(); });
      var bar = document.createElement("div");
      bar.className = "ytct-toolbar";
      bar.appendChild(copyBtn);
      bar.appendChild(backBtn);
      box.appendChild(bar);
      box.appendChild(ta);
      document.documentElement.appendChild(box);
    });

    toolbar.appendChild(sortBtn);
    toolbar.appendChild(filtBtn);
    toolbar.appendChild(rescanBtn);
    toolbar.appendChild(sampleBtn);

    var listWrap = document.createElement("div");
    listWrap.className = "ytct-list";

    // Always-visible "jump to last opened" button, floating over the list so
    // it stays in view no matter how far you scroll. Greyed out until there's
    // a last-opened video recorded for this channel.
    var jump = document.createElement("button");
    jump.id = "ytct-jump";
    jump.type = "button";
    jump.textContent = "\u2193 Jump to last";
    jump.title = "Scroll to the video you last opened";
    jump.addEventListener(
      "click",
      function (e) {
        e.preventDefault();
        e.stopPropagation();
        jumpToLast(listWrap);
      },
      true
    );

    ov.appendChild(header);
    ov.appendChild(toolbar);
    ov.appendChild(listWrap);
    ov.appendChild(jump);
    document.documentElement.appendChild(ov);

    renderList(listWrap, rec.videos);
    updateJumpState();
  }

  function updateJumpState() {
    var btn = document.getElementById("ytct-jump");
    if (!btn) return;
    var has = !!(currentRec && currentRec.lastOpenedId);
    btn.disabled = !has;
    btn.classList.toggle("ytct-jump-off", !has);
  }

  // Scroll the list to the last-opened video and flash it. If that video is
  // hidden by the current filter, fall back to the nearest visible row by seq.
  function jumpToLast(wrap) {
    if (!currentRec || !currentRec.lastOpenedId) return;
    var id = currentRec.lastOpenedId;
    var target = wrap.querySelector('.ytct-row[data-vid="' + id + '"]');
    if (!target) {
      target = nearestVisibleRow(wrap, id);
      if (target) toast("Last video hidden by filter \u2014 jumped to nearest");
      else {
        toast("Last video not in current view");
        return;
      }
    }
    target.scrollIntoView({ block: "center" });
    flashRow(target);
  }

  function nearestVisibleRow(wrap, id) {
    var src = null;
    for (var i = 0; i < currentRec.videos.length; i++) {
      if (currentRec.videos[i].id === id) {
        src = currentRec.videos[i];
        break;
      }
    }
    if (!src) return null;
    var rows = wrap.querySelectorAll(".ytct-row[data-seq]");
    var best = null;
    var bestD = Infinity;
    for (var j = 0; j < rows.length; j++) {
      var s = parseInt(rows[j].getAttribute("data-seq"), 10);
      var d = Math.abs(s - (src.seq || 0));
      if (d < bestD) {
        bestD = d;
        best = rows[j];
      }
    }
    return best;
  }

  function flashRow(row) {
    row.classList.remove("ytct-row-flash");
    // Reflow so the animation restarts even on repeated jumps.
    void row.offsetWidth;
    row.classList.add("ytct-row-flash");
    setTimeout(function () {
      row.classList.remove("ytct-row-flash");
    }, 2200);
  }

  // Remember which video the user just opened, persist it, and reflect it in
  // the UI (highlight + enable the jump button).
  function markLastOpened(id) {
    if (!currentRec) return;
    currentRec.lastOpenedId = id;
    saveRecord(currentRec.channelKey, currentRec);
    updateJumpState();
    var wrap = document.querySelector("#" + OVERLAY_ID + " .ytct-list");
    if (wrap) {
      var prev = wrap.querySelectorAll(".ytct-row-last");
      for (var i = 0; i < prev.length; i++) {
        prev[i].classList.remove("ytct-row-last");
      }
      var cur = wrap.querySelector('.ytct-row[data-vid="' + id + '"]');
      if (cur) cur.classList.add("ytct-row-last");
    }
  }

  function filterLabel() {
    return filterMode === "all"
      ? "Show: All"
      : filterMode === "unwatched"
      ? "Show: Unwatched"
      : "Show: Watched";
  }

  function isWatched(v) {
    return v.progress != null && v.progress >= 90;
  }
  function isUnwatched(v) {
    return v.progress == null || v.progress <= 5;
  }

  function countWatched(videos) {
    var w = 0;
    var u = 0;
    for (var i = 0; i < videos.length; i++) {
      if (isWatched(videos[i])) w++;
      else if (isUnwatched(videos[i])) u++;
    }
    return { watched: w, unwatched: u };
  }

  function orderedVideos(videos) {
    var arr = videos.slice();
    // DOM order is newest-first, captured as ascending seq. Oldest->newest is
    // the reverse of seq.
    arr.sort(function (a, b) {
      return (b.seq || 0) - (a.seq || 0); // ascending = oldest first
    });
    if (!sortAsc) arr.reverse();
    return arr;
  }

  function renderList(wrap, videos) {
    wrap.textContent = "";
    var arr = orderedVideos(videos).filter(function (v) {
      if (filterMode === "unwatched") return !isWatched(v);
      if (filterMode === "watched") return isWatched(v);
      return true;
    });
    if (!arr.length) {
      var empty = document.createElement("div");
      empty.className = "ytct-empty";
      empty.textContent = "Nothing to show with this filter.";
      wrap.appendChild(empty);
      return;
    }
    var frag = document.createDocumentFragment();
    for (var i = 0; i < arr.length; i++) {
      frag.appendChild(rowFor(arr[i]));
    }
    wrap.appendChild(frag);
    setupLazyImages(wrap);
  }

  function rowFor(v) {
    var row = document.createElement("div");
    row.className = "ytct-row";
    row.setAttribute("data-vid", v.id);
    if (v.seq != null) row.setAttribute("data-seq", v.seq);
    if (currentRec && currentRec.lastOpenedId === v.id) {
      row.classList.add("ytct-row-last");
    }

    var thumbWrap = document.createElement("div");
    thumbWrap.className = "ytct-thumb";

    var img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    img.setAttribute("data-src", v.thumb || "");
    thumbWrap.appendChild(img);

    if (v.duration) {
      var dur = document.createElement("span");
      dur.className = "ytct-dur";
      dur.textContent = v.duration;
      thumbWrap.appendChild(dur);
    }

    // Reproduce YouTube's native red progress bar.
    if (v.progress != null && v.progress > 0) {
      var barWrap = document.createElement("div");
      barWrap.className = "ytct-bar";
      var bar = document.createElement("div");
      bar.className = "ytct-bar-fill";
      bar.style.width = Math.min(100, v.progress) + "%";
      barWrap.appendChild(bar);
      thumbWrap.appendChild(barWrap);
    }

    var meta = document.createElement("div");
    meta.className = "ytct-meta";
    var title = document.createElement("div");
    title.className = "ytct-row-title";
    title.textContent = v.title || v.id;
    var sub = document.createElement("div");
    sub.className = "ytct-row-sub";
    sub.textContent = isWatched(v)
      ? "Watched"
      : v.progress
      ? v.progress + "% watched"
      : "Not watched";
    meta.appendChild(title);
    meta.appendChild(sub);

    row.appendChild(thumbWrap);
    row.appendChild(meta);

    row.addEventListener("click", function () {
      markLastOpened(v.id);
      openTab("https://m.youtube.com/watch?v=" + v.id);
    });

    return row;
  }

  // ---- Lazy image loading --------------------------------------------------
  var lazyObserver = null;
  function setupLazyImages(wrap) {
    var imgs = wrap.querySelectorAll("img[data-src]");
    if (!("IntersectionObserver" in window)) {
      for (var i = 0; i < imgs.length; i++) {
        imgs[i].src = imgs[i].getAttribute("data-src");
        imgs[i].removeAttribute("data-src");
      }
      return;
    }
    if (lazyObserver) lazyObserver.disconnect();
    lazyObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) {
            var im = en.target;
            var src = im.getAttribute("data-src");
            if (src) {
              im.src = src;
              im.removeAttribute("data-src");
            }
            lazyObserver.unobserve(im);
          }
        });
      },
      { root: wrap, rootMargin: "200px" }
    );
    for (var j = 0; j < imgs.length; j++) lazyObserver.observe(imgs[j]);
  }

  function closeOverlay() {
    var o = document.getElementById(OVERLAY_ID);
    if (o) o.remove();
    if (lazyObserver) {
      lazyObserver.disconnect();
      lazyObserver = null;
    }
    refreshFabLabel();
  }

  // ---- Tiny UI helpers -----------------------------------------------------
  function mkBtn(label, fn) {
    var b = document.createElement("button");
    b.className = "ytct-tbtn";
    b.textContent = label;
    b.addEventListener("click", fn, true);
    return b;
  }

  var toastTimer = null;
  function toast(msg) {
    var t = document.getElementById("ytct-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "ytct-toast";
      document.documentElement.appendChild(t);
    }
    t.textContent = msg;
    t.style.display = "block";
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      t.style.display = "none";
    }, 2600);
  }

  function showProgressToast() {
    var t = document.getElementById("ytct-progress");
    if (!t) {
      t = document.createElement("div");
      t.id = "ytct-progress";
      var span = document.createElement("span");
      span.id = "ytct-progress-text";
      span.textContent = "Scanning\u2026 0";
      var cancel = document.createElement("button");
      cancel.textContent = "Stop";
      cancel.addEventListener("click", function () {
        cancelScan = true;
      });
      t.appendChild(span);
      t.appendChild(cancel);
      document.documentElement.appendChild(t);
    }
    t.style.display = "flex";
  }
  function updateProgressToast(n) {
    var s = document.getElementById("ytct-progress-text");
    if (s) s.textContent = "Scanning\u2026 " + n;
  }
  function hideProgressToast() {
    var t = document.getElementById("ytct-progress");
    if (t) t.style.display = "none";
  }

  function confirmDialog(msg, okText, onOk, altText, onAlt) {
    var back = document.createElement("div");
    back.className = "ytct-modal-back";
    var box = document.createElement("div");
    box.className = "ytct-modal";
    var p = document.createElement("p");
    p.textContent = msg;
    box.appendChild(p);
    var btns = document.createElement("div");
    btns.className = "ytct-modal-btns";

    function done() {
      back.remove();
    }
    var ok = document.createElement("button");
    ok.className = "ytct-modal-ok";
    ok.textContent = okText;
    ok.addEventListener("click", function () {
      done();
      onOk && onOk();
    });
    btns.appendChild(ok);

    if (altText) {
      var alt = document.createElement("button");
      alt.textContent = altText;
      alt.addEventListener("click", function () {
        done();
        onAlt && onAlt();
      });
      btns.appendChild(alt);
    }
    var cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", done);
    btns.appendChild(cancel);

    box.appendChild(btns);
    back.appendChild(box);
    back.addEventListener("click", function (e) {
      if (e.target === back) done();
    });
    document.documentElement.appendChild(back);
  }

  function timeAgo(ts) {
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return s + "s ago";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    var d = Math.floor(h / 24);
    return d + "d ago";
  }

  // ---- Styles --------------------------------------------------------------
  function injectStyles() {
    if (document.getElementById("ytct-style")) return;
    var css = [
      "#" + FAB_ID + "{position:fixed;right:14px;bottom:90px;z-index:2147483646;",
      "background:#cc0000;color:#fff;border:none;border-radius:22px;padding:10px 16px;",
      "font:600 14px system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.4);}",
      "#" + OVERLAY_ID + "{position:fixed;inset:0;z-index:2147483646;background:#0f0f0f;",
      "color:#fff;display:flex;flex-direction:column;font:14px system-ui,sans-serif;}",
      ".ytct-header{display:flex;align-items:center;gap:10px;padding:12px 14px;",
      "border-bottom:1px solid #272727;}",
      ".ytct-title{font-weight:700;font-size:16px;flex:0 1 auto;overflow:hidden;",
      "text-overflow:ellipsis;white-space:nowrap;max-width:55%;}",
      ".ytct-stats{font-size:12px;color:#aaa;flex:1 1 auto;}",
      ".ytct-close{margin-left:auto;background:none;border:none;color:#fff;font-size:20px;}",
      ".ytct-toolbar{display:flex;gap:8px;padding:8px 14px;overflow-x:auto;",
      "border-bottom:1px solid #272727;}",
      ".ytct-tbtn{background:#272727;color:#fff;border:none;border-radius:16px;",
      "padding:7px 12px;font-size:13px;white-space:nowrap;}",
      ".ytct-list{flex:1 1 auto;overflow-y:auto;-webkit-overflow-scrolling:touch;}",
      ".ytct-row{display:flex;gap:10px;padding:8px 12px;border-bottom:1px solid #1c1c1c;",
      "align-items:flex-start;}",
      ".ytct-thumb{position:relative;width:140px;flex:0 0 140px;aspect-ratio:16/9;",
      "background:#1c1c1c;border-radius:6px;overflow:hidden;}",
      ".ytct-thumb img{width:100%;height:100%;object-fit:cover;display:block;}",
      ".ytct-dur{position:absolute;right:4px;bottom:4px;background:rgba(0,0,0,.8);",
      "color:#fff;font-size:11px;padding:1px 4px;border-radius:3px;}",
      ".ytct-bar{position:absolute;left:0;right:0;bottom:0;height:3px;background:rgba(255,255,255,.3);}",
      ".ytct-bar-fill{height:100%;background:#f00;}",
      ".ytct-meta{flex:1 1 auto;min-width:0;}",
      ".ytct-row-title{font-size:14px;line-height:1.3;max-height:3.9em;overflow:hidden;}",
      ".ytct-row-sub{font-size:12px;color:#aaa;margin-top:4px;}",
      ".ytct-empty{padding:40px 16px;text-align:center;color:#aaa;}",
      "#ytct-jump{position:absolute;right:16px;bottom:18px;z-index:5;",
      "background:#cc0000;color:#fff;border:none;border-radius:20px;padding:10px 16px;",
      "font:600 13px system-ui,sans-serif;box-shadow:0 3px 10px rgba(0,0,0,.5);cursor:pointer;}",
      "#ytct-jump.ytct-jump-off{background:#2a2a2a;color:#666;box-shadow:none;cursor:default;}",
      ".ytct-row-last{background:#1d1c10;}",
      ".ytct-row-flash{animation:ytctflash 2.2s ease-out;}",
      "@keyframes ytctflash{0%{background:#5a4a00;}100%{background:transparent;}}",
      "#ytct-toast{position:fixed;left:50%;bottom:120px;transform:translateX(-50%);",
      "z-index:2147483647;background:#333;color:#fff;padding:10px 16px;border-radius:8px;",
      "font:14px system-ui;display:none;max-width:80%;text-align:center;}",
      "#ytct-progress{position:fixed;left:50%;bottom:120px;transform:translateX(-50%);",
      "z-index:2147483647;background:#222;color:#fff;padding:10px 14px;border-radius:10px;",
      "display:none;align-items:center;gap:12px;font:14px system-ui;box-shadow:0 2px 10px rgba(0,0,0,.5);}",
      "#ytct-progress button{background:#cc0000;color:#fff;border:none;border-radius:8px;padding:6px 10px;}",
      ".ytct-modal-back{position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.6);",
      "display:flex;align-items:center;justify-content:center;}",
      ".ytct-modal{background:#212121;color:#fff;border-radius:12px;padding:18px;max-width:84%;",
      "font:15px system-ui;}",
      ".ytct-modal p{margin:0 0 16px;line-height:1.4;}",
      ".ytct-modal-btns{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;}",
      ".ytct-modal-btns button{border:none;border-radius:8px;padding:9px 14px;font-size:14px;",
      "background:#383838;color:#fff;}",
      ".ytct-modal-ok{background:#cc0000 !important;}"
    ].join("");
    var s = document.createElement("style");
    s.id = "ytct-style";
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  // ---- Boot / SPA navigation handling -------------------------------------
  var lastUrl = location.href;
  function onNav() {
    if (isVideosTab()) {
      injectStyles();
      ensureFab();
    } else {
      removeFab();
      closeOverlay();
    }
  }

  function watchUrl() {
    setInterval(function () {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        onNav();
      } else if (isVideosTab() && !document.getElementById(FAB_ID)) {
        // Re-add FAB if YouTube re-rendered the page and wiped it.
        ensureFab();
      }
    }, 1200);
  }

  injectStyles();
  onNav();
  watchUrl();
})();
