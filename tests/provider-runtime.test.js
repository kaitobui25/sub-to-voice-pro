"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../lib/translation-core.js");
require("../lib/providers/gemini.js");
require("../lib/tts-core.js");
require("../lib/providers/novai.js");
const runtime = require("../lib/providers/runtime.js");

test("provider runtime builds configured translation and TTS managers", () => {
  const translationManager = runtime.createTranslationManager({
    provider: "gemini",
    apiKey: "test-key",
    baseUrl: "https://example.test/v1beta",
    models: ["gemini-test"]
  });
  const ttsManager = runtime.createTTSManager({
    provider: "novai",
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    model: "speech-test",
    voice: "voice-test"
  });

  assert.equal(translationManager.providerName, "gemini");
  assert.equal(ttsManager.providerName, "novai");
});

test("provider runtime rejects unknown configured providers", () => {
  assert.throws(
    () => runtime.createTranslationManager({ provider: "unknown", models: ["m"] }),
    /Unsupported translation provider/
  );
  assert.throws(
    () => runtime.createTTSManager({ provider: "unknown" }),
    /Unsupported TTS provider/
  );
});
