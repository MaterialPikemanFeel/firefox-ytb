"use strict";

var DEFAULTS = {
  fadeSeconds: 8,
  persistent: false,
  debug: false,
};

var fadeEl = document.getElementById("fade");
var fadeValueEl = document.getElementById("fadeValue");
var fadeFieldset = document.getElementById("fadeFieldset");
var persistentEl = document.getElementById("persistent");
var debugEl = document.getElementById("debug");
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

function save() {
  var values = {
    fadeSeconds: parseInt(fadeEl.value, 10),
    persistent: persistentEl.checked,
    debug: debugEl.checked,
  };
  browser.storage.local.set(values).then(flashSaved, function () {});
}

function load() {
  browser.storage.local.get(DEFAULTS).then(function (res) {
    fadeEl.value = res.fadeSeconds;
    persistentEl.checked = res.persistent;
    debugEl.checked = res.debug;
    renderFade();
  });
}

fadeEl.addEventListener("input", renderFade);
fadeEl.addEventListener("change", save);
persistentEl.addEventListener("change", function () {
  renderFade();
  save();
});
debugEl.addEventListener("change", save);

load();
