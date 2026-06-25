// ==UserScript==
// @name         YouTube Channel Tracker (mobile)
// @namespace    https://github.com/MaterialPikemanFeel/firefox-ytb
// @version      1.2.0
// @downloadURL  https://raw.githubusercontent.com/MaterialPikemanFeel/firefox-ytb/devin/1782401112-replay-extension/channel-tracker/yt-channel-tracker.user.js
// @updateURL    https://raw.githubusercontent.com/MaterialPikemanFeel/firefox-ytb/devin/1782401112-replay-extension/channel-tracker/yt-channel-tracker.user.js
// @description  Build a fixed, cached, oldest-to-newest list of a channel's videos on m.youtube.com, showing YouTube's native watched progress and letting you filter unwatched. For Firefox Android + Violentmonkey.
// @author       MaterialPikemanFeel
// @match        https://m.youtube.com/*
// @match        https://www.youtube.com/*
// @run-at       document-start
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
    },
    keys: function () {
      try {
        if (typeof GM !== "undefined" && GM && GM.listValues) {
          return Promise.resolve(GM.listValues());
        }
      } catch (e) {}
      try {
        return Promise.resolve(
          typeof GM_listValues === "function" ? GM_listValues() : []
        );
      } catch (e2) {
        return Promise.resolve([]);
      }
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
  var cameFromHub = false; // true when a list was opened from the hub
  // Capture the hub intent at document-start, BEFORE YouTube's SPA strips the
  // unknown ?ytct=hub query param and rewrites the URL to a clean home page.
  // Once captured this stays true for the whole page load, so the hub stays
  // mounted no matter how YouTube mangles the address afterwards.
  var hubMode = /ytct=hub/.test(location.href);

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
    // Prefer the channel-header element on the page itself.
    var sel = [
      "ytm-channel-header-renderer .channel-title",
      ".channel-header-title-text",
      "ytm-c4-tabbed-header-renderer .channel-title",
      ".channel-title"
    ];
    for (var i = 0; i < sel.length; i++) {
      var el = document.querySelector(sel[i]);
      var txt = el && (el.textContent || "").trim();
      if (txt) return txt;
    }
    // Fall back to the @handle in the URL — reliable on a channel page and
    // never a stale video title left over from SPA navigation.
    var h = location.pathname.match(/\/@([^/?#]+)/);
    if (h) return "@" + decodeURIComponent(h[1]);
    // og:title / document.title last: on mobile these can briefly hold the
    // last-watched video's title, so only use them as a final resort.
    var og = document.querySelector('meta[property="og:title"]');
    if (og && og.content) return og.content.trim();
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
      out.push({
        id: id,
        title: title,
        thumb: extractThumb(card, id),
        duration: extractDuration(card),
        progress: extractProgress(card)
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

  // Compute the watched percentage (0..100, or null when there's no resume bar).
  function extractProgress(card) {
    if (!card) return null;

    var signal = false;
    var el = card.querySelector(PROGRESS_SELECTOR);
    if (!el) {
      var all = card.querySelectorAll('[class*="rogress"], [class*="esume"], [class*="layed"], [role="progressbar"]');
      for (var i = 0; i < all.length; i++) {
        signal = true;
        // Skip the always-full-width host/container; we want the played segment.
        if (/Host\b|RendererHost/.test(all[i].className || "")) continue;
        if (pctFromEl(all[i]) != null || scaleXFromEl(all[i]) != null) {
          el = all[i];
          break;
        }
      }
      // If only the host matched, drill into its descendants for a non-full-width
      // segment that carries the actual progress (width%, scaleX, or px ratio).
      if (!el) {
        var host = card.querySelector("ytm-thumbnail-overlay-resume-playback-renderer, [class*='ResumePlaybackRendererHost']") ||
          (all.length ? all[0] : null);
        if (host) {
          var kids = host.querySelectorAll("*");
          for (var k = 0; k < kids.length; k++) {
            if (pctFromEl(kids[k]) != null || scaleXFromEl(kids[k]) != null) {
              el = kids[k];
              break;
            }
          }
          if (!el) el = host;
        }
      }
    }

    if (el) {
      // Prefer the most reliable signals first: inline width% / aria, then the
      // transform scaleX used by mobile YouTube, then a computed px ratio.
      var width = null, aria = null, ratio = null;
      var w = el.style && el.style.width ? el.style.width : "";
      var pm = w.match(/([\d.]+)%/);
      if (pm) width = clampPct(parseFloat(pm[1]));
      var av = el.getAttribute && el.getAttribute("aria-valuenow");
      if (av != null && av !== "" && !isNaN(parseFloat(av))) aria = clampPct(parseFloat(av));
      try {
        var cs = parseFloat(getComputedStyle(el).width);
        var pw = el.parentElement ? parseFloat(getComputedStyle(el.parentElement).width) : 0;
        if (cs && pw && pw > cs * 0.2) ratio = clampPct((cs / pw) * 100);
      } catch (e) {}
      var scaleX = scaleXFromEl(el);

      if (width != null) return width;
      if (aria != null) return aria;
      if (scaleX != null) return scaleX;
      if (ratio != null) return ratio;
    }

    return signal ? 50 : null;
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

  // Load every cached channel record from storage.
  function loadAllRecords() {
    return store.keys().then(function (keys) {
      keys = keys || [];
      var jobs = [];
      for (var i = 0; i < keys.length; i++) {
        if (String(keys[i]).indexOf(PREFIX) !== 0) continue;
        jobs.push(
          store.get(keys[i], null).then(function (raw) {
            if (!raw) return null;
            try {
              return typeof raw === "string" ? JSON.parse(raw) : raw;
            } catch (e) {
              return null;
            }
          })
        );
      }
      return Promise.all(jobs).then(function (recs) {
        return recs.filter(function (r) {
          return r && r.videos && r.videos.length;
        });
      });
    });
  }

  // The newest video (smallest seq) — used for the hub cover thumbnail.
  function newestVideo(rec) {
    var best = null;
    var vids = (rec && rec.videos) || [];
    for (var i = 0; i < vids.length; i++) {
      if (best === null || (vids[i].seq || 0) < (best.seq || 0)) best = vids[i];
    }
    return best;
  }

  // ---- Hub: a bookmarkable overview of every cached channel ----------------
  // Entry URL: https://m.youtube.com/?ytct=hub (bookmark this).
  var hubSort = "recent"; // recent | name | unwatched

  function isHubRoute() {
    return (
      hubMode ||
      /[?&]ytct=hub/.test(location.search) ||
      /ytct=hub/.test(location.hash)
    );
  }

  function hubSortLabel() {
    return hubSort === "recent"
      ? "Sort: Recently scanned"
      : hubSort === "name"
      ? "Sort: Name (A\u2013Z)"
      : "Sort: Most unwatched";
  }

  function sortHubRecords(recs) {
    var arr = recs.slice();
    if (hubSort === "name") {
      arr.sort(function (a, b) {
        return String(a.title || "").localeCompare(String(b.title || ""));
      });
    } else if (hubSort === "unwatched") {
      arr.sort(function (a, b) {
        return countWatched(b.videos).unwatched - countWatched(a.videos).unwatched;
      });
    } else {
      arr.sort(function (a, b) {
        return (b.scannedAt || 0) - (a.scannedAt || 0);
      });
    }
    return arr;
  }

  function openHub() {
    closeOverlay();
    var ov = document.createElement("div");
    ov.id = OVERLAY_ID;
    ov.className = "ytct-hub";

    var header = document.createElement("div");
    header.className = "ytct-header";
    var titleEl = document.createElement("div");
    titleEl.className = "ytct-title";
    titleEl.textContent = "Channel Tracker";
    var stats = document.createElement("div");
    stats.className = "ytct-stats";
    stats.id = "ytct-hub-stats";
    header.appendChild(titleEl);
    header.appendChild(stats);

    var toolbar = document.createElement("div");
    toolbar.className = "ytct-toolbar";
    var sortBtn = mkBtn(hubSortLabel(), function () {
      hubSort =
        hubSort === "recent" ? "name" : hubSort === "name" ? "unwatched" : "recent";
      sortBtn.textContent = hubSortLabel();
      paint();
    });
    toolbar.appendChild(sortBtn);

    var grid = document.createElement("div");
    grid.className = "ytct-hub-grid";

    ov.appendChild(header);
    ov.appendChild(toolbar);
    ov.appendChild(grid);
    document.documentElement.appendChild(ov);

    var records = [];
    function paint() {
      grid.textContent = "";
      var st = document.getElementById("ytct-hub-stats");
      if (st) st.textContent = records.length + " channels";
      if (!records.length) {
        var empty = document.createElement("div");
        empty.className = "ytct-empty";
        empty.textContent =
          "No channels cached yet. Open a channel's Videos tab and tap Scan.";
        grid.appendChild(empty);
        return;
      }
      var arr = sortHubRecords(records);
      var frag = document.createDocumentFragment();
      for (var i = 0; i < arr.length; i++) frag.appendChild(hubCard(arr[i]));
      grid.appendChild(frag);
    }

    loadAllRecords().then(function (recs) {
      records = recs;
      paint();
    });
  }

  function hubCard(rec) {
    var card = document.createElement("div");
    card.className = "ytct-hub-card";

    var thumbWrap = document.createElement("div");
    thumbWrap.className = "ytct-hub-thumb";
    var nv = newestVideo(rec);
    var img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    if (nv && nv.thumb) img.src = nv.thumb;
    thumbWrap.appendChild(img);

    var body = document.createElement("div");
    body.className = "ytct-hub-body";
    var name = document.createElement("div");
    name.className = "ytct-hub-name";
    name.textContent = rec.title || rec.channelKey;
    var counts = countWatched(rec.videos);
    var sub = document.createElement("div");
    sub.className = "ytct-hub-sub";
    sub.textContent =
      rec.videos.length +
      " videos \u00b7 " +
      counts.unwatched +
      " unwatched \u00b7 " +
      (rec.scannedAt ? timeAgo(rec.scannedAt) : "?");
    body.appendChild(name);
    body.appendChild(sub);

    var del = document.createElement("button");
    del.className = "ytct-hub-del";
    del.textContent = "\u2715";
    del.title = "Remove this channel from the tracker";
    del.addEventListener(
      "click",
      function (e) {
        e.stopPropagation();
        confirmDialog(
          "Remove \u201c" + (rec.title || rec.channelKey) + "\u201d from the tracker? The cached list will be deleted.",
          "Remove",
          function () {
            store.del(recordKey(rec.channelKey)).then(function () {
              openHub();
            });
          }
        );
      },
      true
    );

    card.appendChild(thumbWrap);
    card.appendChild(body);
    card.appendChild(del);
    card.addEventListener("click", function () {
      cameFromHub = true;
      openOverlay(rec);
    });
    return card;
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
    fab.title = "Channel Tracker";
    fab.addEventListener("click", onFabClick, true);
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
      lastOpenedId: (existing && existing.lastOpenedId) || null,
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
    // Re-derive a fresh channel name when we're on a channel page; this also
    // repairs records that stored a stale video title from older versions.
    var live = isChannelPage() ? channelTitle() : "";
    if (live && live !== rec.title) {
      rec.title = live;
      saveRecord(rec.channelKey, rec);
    }
    titleEl.textContent = rec.title || "Channel";

    var stats = document.createElement("div");
    stats.className = "ytct-stats";
    stats.textContent =
      rec.videos.length +
      " videos · watched " +
      counts.watched +
      " / unwatched " +
      counts.unwatched;

    var close = document.createElement("button");
    close.className = "ytct-close";
    close.textContent = "\u2715";
    close.addEventListener("click", closeList, true);

    header.appendChild(titleEl);
    header.appendChild(stats);
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
      // Scanning needs the channel's live Videos page. When the list was
      // opened from the hub (no channel page loaded), navigate there instead.
      if (!isChannelPage()) {
        if (rec.url) location.href = rec.url;
        else toast("Open the channel's Videos page to rescan");
        return;
      }
      cameFromHub = false;
      closeOverlay();
      runScan(rec.channelKey, false);
    });

    toolbar.appendChild(sortBtn);
    toolbar.appendChild(filtBtn);
    toolbar.appendChild(rescanBtn);

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

  // Close a list overlay; if it was opened from the hub, go back to the hub
  // instead of returning to the underlying YouTube page.
  function closeList() {
    var hub = cameFromHub;
    cameFromHub = false;
    closeOverlay();
    if (hub) openHub();
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
      ".ytct-modal-ok{background:#cc0000 !important;}",
      // Hub overview
      "#" + OVERLAY_ID + ".ytct-hub .ytct-toolbar{position:sticky;top:0;background:#0f0f0f;z-index:2;}",
      ".ytct-hub-grid{flex:1 1 auto;overflow-y:auto;-webkit-overflow-scrolling:touch;",
      "display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));",
      "gap:12px;padding:14px;align-content:start;}",
      ".ytct-hub-card{position:relative;background:#1c1c1c;border-radius:10px;overflow:hidden;",
      "cursor:pointer;transition:background .15s;}",
      ".ytct-hub-card:active{background:#272727;}",
      ".ytct-hub-thumb{position:relative;width:100%;aspect-ratio:16/9;background:#000;}",
      ".ytct-hub-thumb img{width:100%;height:100%;object-fit:cover;display:block;}",
      ".ytct-hub-body{padding:8px 10px 10px;}",
      ".ytct-hub-name{font-size:14px;font-weight:600;line-height:1.25;",
      "display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}",
      ".ytct-hub-sub{font-size:11.5px;color:#aaa;margin-top:5px;}",
      ".ytct-hub-del{position:absolute;top:6px;right:6px;width:26px;height:26px;",
      "border:none;border-radius:50%;background:rgba(0,0,0,.65);color:#fff;font-size:14px;",
      "line-height:1;display:flex;align-items:center;justify-content:center;}"
    ].join("");
    var s = document.createElement("style");
    s.id = "ytct-style";
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  // ---- Boot / SPA navigation handling -------------------------------------
  var lastUrl = location.href;
  function onNav() {
    if (isHubRoute()) {
      injectStyles();
      removeFab();
      cameFromHub = false;
      if (!document.querySelector("#" + OVERLAY_ID + ".ytct-hub")) openHub();
      return;
    }
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
      } else if (isHubRoute()) {
        // Keep the hub mounted even if YouTube re-rendered the document.
        if (!document.getElementById(OVERLAY_ID)) openHub();
      } else if (isVideosTab() && !document.getElementById(FAB_ID)) {
        // Re-add FAB if YouTube re-rendered the page and wiped it.
        ensureFab();
      }
    }, 1200);
  }

  function boot() {
    injectStyles();
    onNav();
    watchUrl();
  }

  // We now run at document-start (to capture ?ytct=hub before YouTube strips
  // it), so the DOM may not be ready yet. Defer the DOM-dependent boot.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
