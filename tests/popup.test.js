"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("popup switch controls dubbing while volume is saved separately", async () => {
  const elements = new Map();
  for (const id of ["enabled", "original-volume", "volume-value", "status", "download-transcript", "download-diagnostics", "translation-provider", "tts-provider", "voice-mode", "speaker-panel", "speaker-list"]) {
    elements.set(id, { checked: false, disabled: true, value: "", textContent: "", handlers: {},
      addEventListener(type, handler) { this.handlers[type] = handler; } });
  }
  const calls = [];
  const downloads = [];
  const blobs = [];
  let popupVoiceMode = "single";
  const context = {
    document: {
      getElementById(id) { return elements.get(id); },
      body: { appendChild() {} },
      createElement() { return { click() { downloads.push(this.download); }, remove() {} }; }
    },
    Blob,
    URL: {
      createObjectURL(blob) { blobs.push(blob); return "blob:test"; },
      revokeObjectURL() {}
    },
    chrome: {
      tabs: { async query() { return [{ id: 7 }]; } },
      runtime: {
        onMessage: { addListener() {} },
        async sendMessage(message) {
          calls.push(message);
          if (message.type === "GET_DIAGNOSTIC_LOG") return {
            ok: true, log: { schemaVersion: 1, videoId: "test-video", events: [{ type: "pause" }] }
          };
          if (message.type === "GET_POPUP_STATE") return {
            ok: true, enabled: false, canStart: true, status: "Ready", originalVolume: 18,
            translationSelection: "google", ttsSelection: "vieneu", voiceMode: popupVoiceMode,
            speakers: popupVoiceMode === "multi" ? [
              { label: "S1", voice: "Hải Đăng" }, { label: "S2", voice: "Thái Sơn" }
            ] : []
          };
          if (message.type === "SET_ENABLED") return {
            ok: true, enabled: message.enabled, status: "Translating"
          };
          if (message.type === "SET_VOICE_MODE") popupVoiceMode = message.value;
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
  assert.equal(elements.get("translation-provider").value, "google");
  assert.equal(elements.get("tts-provider").value, "vieneu");
  assert.equal(elements.get("voice-mode").value, "single");
  assert.equal(elements.get("speaker-panel").hidden, true);

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

  const translation = elements.get("translation-provider");
  translation.value = "auto";
  await translation.handlers.change();
  assert.equal(calls.at(-2).type, "SET_PROVIDER_SELECTION");
  assert.equal(calls.at(-2).kind, "translation");
  assert.equal(calls.at(-2).value, "auto");

  const tts = elements.get("tts-provider");
  tts.value = "gemini";
  await tts.handlers.change();
  assert.equal(calls.at(-2).kind, "tts");
  assert.equal(calls.at(-2).value, "gemini");

  const voiceMode = elements.get("voice-mode");
  voiceMode.value = "multi";
  await voiceMode.handlers.change();
  assert.equal(calls.at(-2).type, "SET_VOICE_MODE");
  assert.equal(calls.at(-2).value, "multi");
  assert.equal(elements.get("speaker-panel").hidden, false);
  assert.equal(elements.get("speaker-list").textContent, "S1 — Hải Đăng\nS2 — Thái Sơn");
  const diagnostics = elements.get("download-diagnostics");
  assert.equal(diagnostics.disabled, false);
  await diagnostics.handlers.click();
  assert.equal(calls.at(-1).type, "GET_DIAGNOSTIC_LOG");
  assert.equal(calls.at(-1).tabId, 7);
  assert.equal(downloads.at(-1), "sub-to-voice-test-video-diagnostics.json");
  assert.equal(JSON.parse(await blobs.at(-1).text()).events[0].type, "pause");
  assert.equal(diagnostics.disabled, false);
});
