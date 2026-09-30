"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../lib/translation-core.js");
require("../lib/providers/gemini.js");
require("../lib/providers/google-translate.js");
require("../lib/providers/microsoft-translate.js");
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

test("provider selection uses configured orders and defaults", () => {
  const config = {
    translation: { defaultSelection: "google" },
    tts: { defaultSelection: "vieneu" }
  };
  assert.deepEqual(runtime.resolveSelections(config, {}), {
    translation: "google", tts: "vieneu"
  });
  assert.equal(runtime.validSelection("translation", "microsoft"), false);
  assert.deepEqual(runtime.translationConfig({
    orders: { auto: ["google", "microsoft", "gemini"] }
  }, "auto").fallbackProviders, ["microsoft", "gemini"]);
});

test("google translation mode registers Microsoft fallback without requiring Gemini", () => {
  const manager = runtime.createTranslationManager({
    provider: "google", fallbackProviders: ["microsoft"],
    google: { baseUrl: "https://example.test/translate", client: "gtx" },
    microsoft: { authUrl: "https://example.test/auth", baseUrl: "https://example.test/microsoft" }
  });
  assert.equal(manager.providerName, "google");
  assert.deepEqual(manager.fallbackProviders, ["microsoft"]);
});

test("auto TTS falls back to Gemini with its own voice when VieNeu fails", async () => {
  const originalFetch = global.fetch;
  const local = global.SubToVoiceVieNeuTTS;
  const remote = global.SubToVoiceGeminiTTS;
  const originalLocal = local.createVieNeuTTSProvider;
  const originalRemote = remote.createGeminiTTSProvider;
  const calls = [];
  try {
    global.fetch = async () => ({ ok: true, async json() { return { status: "ok" }; } });
    local.createVieNeuTTSProvider = () => ({ async synthesize(request) {
      calls.push(["local", request.voice]);
      throw new Error("busy");
    } });
    remote.createGeminiTTSProvider = () => ({ async synthesize(request) {
      calls.push(["remote", request.voice]);
      return { audio: new ArrayBuffer(1), mimeType: "audio/wav" };
    } });
    await runtime.synthesizeWithSelection({
      autoOrder: ["vieneu", "gemini"],
      profiles: {
        vieneu: { provider: "vieneu", baseUrl: "http://127.0.0.1:8000/v1", voice: "local-voice" },
        gemini: { provider: "gemini", voice: "remote-voice" }
      }
    }, "auto", { text: "hello", speed: 1, signal: new AbortController().signal });
    assert.deepEqual(calls, [["local", "local-voice"], ["remote", "remote-voice"]]);
  } finally {
    global.fetch = originalFetch;
    local.createVieNeuTTSProvider = originalLocal;
    remote.createGeminiTTSProvider = originalRemote;
  }
});
