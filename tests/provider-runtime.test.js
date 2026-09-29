"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../lib/translation-core.js");
require("../lib/providers/gemini.js");
require("../lib/tts-core.js");
require("../lib/providers/gemini-tts.js");
require("../lib/providers/vieneu.js");
const runtime = require("../lib/providers/runtime.js");

test("provider runtime builds configured translation and TTS managers", () => {
  const translationManager = runtime.createTranslationManager({
    provider: "gemini",
    apiKey: "test-key",
    baseUrl: "https://example.test/v1beta",
    models: ["gemini-test"]
  });
  const ttsManager = runtime.createTTSManager({
    provider: "gemini",
    apiKey: "test-key",
    baseUrl: "https://example.test/v1beta",
    models: ["speech-test", "speech-fallback"],
    voice: "voice-test"
  });

  assert.equal(translationManager.providerName, "gemini");
  assert.equal(ttsManager.providerName, "gemini");
});

test("provider runtime builds configured VieNeu TTS manager", () => {
  const ttsManager = runtime.createTTSManager({
    provider: "vieneu",
    baseUrl: "http://127.0.0.1:8000/v1",
    model: "local-speech-model",
    voice: "local-voice",
    sampleRate: 48000
  });
  assert.equal(ttsManager.providerName, "vieneu");
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
