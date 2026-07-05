"use strict";

var DEFAULTS = {
  fadeSeconds: 8,
  persistent: false,
  debug: false,
  continuousRewindSeconds: 3,
  mode: "rewind",
};

var fadeEl = document.getElementById("fade");
var fadeValueEl = document.getElementById("fadeValue");
var fadeFieldset = document.getElementById("fadeFieldset");
var persistentEl = document.getElementById("persistent");
var debugEl = document.getElementById("debug");
var windowEl = document.getElementById("window");
var windowValueEl = document.getElementById("windowValue");
var modeRewindEl = document.getElementById("modeRewind");
var modeABEl = document.getElementById("modeAB");
var rewindSettingsEl = document.getElementById("rewindSettings");
var savedEl = document.getElementById("saved");

var savedTimer = null;
function flashSaved() {
  savedEl.textContent = "Saved";
  if (savedTimer) clearTimeout(savedTimer);
  savedTimer = setTimeout(function () {
    savedEl.textContent = "";
  }, 1200);
}

function renderFade() {
  fadeValueEl.textContent = fadeEl.value + "s";
  fadeFieldset.disabled = persistentEl.checked;
}

function renderMode() {
  var isRewind = modeRewindEl.checked;
  rewindSettingsEl.disabled = !isRewind;
}

function renderWindow() {
  windowValueEl.textContent = windowEl.value + "s";
}

function save() {
  var values = {
    fadeSeconds: parseInt(fadeEl.value, 10),
    persistent: persistentEl.checked,
    debug: debugEl.checked,
    continuousRewindSeconds: parseInt(windowEl.value, 10),
    mode: modeABEl.checked ? "ab" : "rewind",
  };
  browser.storage.local.set(values).then(flashSaved, function () {});
}

function load() {
  browser.storage.local.get(DEFAULTS).then(function (res) {
    fadeEl.value = res.fadeSeconds;
    persistentEl.checked = res.persistent;
    debugEl.checked = res.debug;
    windowEl.value = res.continuousRewindSeconds;
    if (res.mode === "ab") {
      modeABEl.checked = true;
    } else {
      modeRewindEl.checked = true;
    }
    renderFade();
    renderWindow();
    renderMode();
  });
}

fadeEl.addEventListener("input", renderFade);
fadeEl.addEventListener("change", save);
persistentEl.addEventListener("change", function () {
  renderFade();
  save();
});
windowEl.addEventListener("input", renderWindow);
windowEl.addEventListener("change", save);
debugEl.addEventListener("change", save);
modeRewindEl.addEventListener("change", function () { renderMode(); save(); });
modeABEl.addEventListener("change", function () { renderMode(); save(); });

load();
