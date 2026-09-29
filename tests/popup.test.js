"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("popup switch controls dubbing while volume is saved separately", async () => {
  const elements = new Map();
  for (const id of ["enabled", "original-volume", "volume-value", "status"]) {
    elements.set(id, { checked: false, disabled: true, value: "", textContent: "", handlers: {},
      addEventListener(type, handler) { this.handlers[type] = handler; } });
  }
  const calls = [];
  const context = {
    document: { getElementById(id) { return elements.get(id); } },
    chrome: {
      tabs: { async query() { return [{ id: 7 }]; } },
      runtime: {
        onMessage: { addListener() {} },
        async sendMessage(message) {
          calls.push(message);
          if (message.type === "GET_POPUP_STATE") return {
            ok: true, enabled: false, canStart: true, status: "Ready", originalVolume: 18
          };
          if (message.type === "SET_ENABLED") return {
            ok: true, enabled: message.enabled, status: "Translating"
          };
          return { ok: true, originalVolume: message.volume };
        }
      }
    },
    setTimeout,
    clearTimeout
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../popup/popup.js"), "utf8"), context);
  await new Promise(setImmediate);

  const enabled = elements.get("enabled");
  const volume = elements.get("original-volume");
  assert.equal(enabled.disabled, false);
  assert.equal(volume.value, 18);

  volume.value = "35";
  volume.handlers.change();
  enabled.checked = true;
  await enabled.handlers.change();
  assert.deepEqual(calls.slice(-2).map(({ type }) => type), ["SET_ORIGINAL_VOLUME", "SET_ENABLED"]);
  assert.equal(calls.at(-2).volume, 35);
  assert.equal(calls.at(-1).enabled, true);

  enabled.checked = false;
  await enabled.handlers.change();
  assert.equal(calls.at(-1).enabled, false);
});
