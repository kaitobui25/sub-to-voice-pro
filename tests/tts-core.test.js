"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { TTSManager, TTSProviderRegistry } = require("../lib/tts-core.js");
const { createGeminiTTSProvider } = require("../lib/providers/gemini-tts.js");

function makeWavBuffer() {
  const bytes = new Uint8Array(44);
  bytes.set(Buffer.from("RIFF"), 0);
  bytes.set(Buffer.from("WAVE"), 8);
  return bytes.buffer;
}

test("TTSManager delegates provider-neutral synthesis and validates result", async () => {
  const calls = [];
  const registry = new TTSProviderRegistry().register("fake", {
    async synthesize(request) {
      calls.push(request);
      return { audio: makeWavBuffer(), mimeType: "audio/wav" };
    }
  });
  const manager = new TTSManager({ registry, provider: "fake" });
  const controller = new AbortController();

  const result = await manager.synthesize({
    text: "Xin chào",
    voice: "voice-a",
    speed: 1,
    signal: controller.signal
  });

  assert.equal(result.audio.byteLength, 44);
  assert.equal(result.mimeType, "audio/wav");
  assert.deepEqual(calls[0], {
    text: "Xin chào",
    voice: "voice-a",
    speed: 1,
    signal: controller.signal
  });
});

test("TTSManager surfaces provider errors unchanged", async () => {
  const expected = new Error("provider unavailable");
  const registry = new TTSProviderRegistry().register("fake", {
    async synthesize() { throw expected; }
  });
  const manager = new TTSManager({ registry, provider: "fake" });
  await assert.rejects(manager.synthesize({ text: "hello" }), (error) => error === expected);
});

test("TTSManager stops before provider call when signal is already aborted", async () => {
  let called = false;
  const registry = new TTSProviderRegistry().register("fake", {
    async synthesize() {
      called = true;
      return { audio: makeWavBuffer(), mimeType: "audio/wav" };
    }
  });
  const manager = new TTSManager({ registry, provider: "fake" });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    manager.synthesize({ text: "hello", signal: controller.signal }),
    (error) => error && error.name === "AbortError"
  );
  assert.equal(called, false);
});

test("TTSManager rejects empty provider audio", async () => {
  const registry = new TTSProviderRegistry().register("fake", {
    async synthesize() { return { audio: new ArrayBuffer(0), mimeType: "audio/wav" }; }
  });
  const manager = new TTSManager({ registry, provider: "fake" });
  await assert.rejects(manager.synthesize({ text: "hello" }), /empty audio/i);
});

test("Gemini TTS adapter uses configured model, voice and Interactions audio schema", async () => {
  const requests = [];
  const wav = new Uint8Array(makeWavBuffer());
  const provider = createGeminiTTSProvider({
    apiKey: "test-key",
    baseUrl: "https://example.test/v1beta/",
    model: "models/speech-model-from-config",
    voice: "Kore",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            steps: [{
              type: "model_output",
              content: [{
                type: "audio",
                data: Buffer.from(wav).toString("base64"),
                mime_type: "audio/wav"
              }]
            }]
          };
        }
      };
    }
  });

  const result = await provider.synthesize({ text: "Xin chào", speed: 1 });
  assert.equal(requests[0].url, "https://example.test/v1beta/interactions");
  assert.equal(requests[0].options.headers["x-goog-api-key"], "test-key");
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.model, "speech-model-from-config");
  assert.equal(body.input[0].content[0].text, "Xin chào");
  assert.deepEqual(body.response_format, { type: "audio", mime_type: "audio/wav" });
  assert.deepEqual(body.generation_config.speech_config, [{ voice: "Kore" }]);
  assert.equal(result.mimeType, "audio/wav");
  assert.equal(result.audio.byteLength, 44);
});

test("Gemini TTS adapter rejects unsupported numeric speed without silently changing speech", async () => {
  const provider = createGeminiTTSProvider({
    apiKey: "test-key",
    baseUrl: "https://example.test/v1beta",
    model: "speech-model",
    voice: "Kore",
    fetchImpl: async () => { throw new Error("must not call"); }
  });
  await assert.rejects(provider.synthesize({ text: "hello", speed: 1.2 }), /requires speed=1/);
});

test("Gemini TTS adapter reports provider errors without exposing key", async () => {
  const provider = createGeminiTTSProvider({
    apiKey: "super-secret-key",
    baseUrl: "https://example.test/v1beta",
    model: "speech-model",
    voice: "Kore",
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      async text() {
        return JSON.stringify({ error: { message: "invalid super-secret-key" } });
      }
    })
  });
  await assert.rejects(provider.synthesize({ text: "hello", speed: 1 }), (error) => {
    assert.match(error.message, /401/);
    assert.doesNotMatch(error.message, /super-secret-key/);
    assert.match(error.message, /\[redacted\]/);
    return true;
  });
});
