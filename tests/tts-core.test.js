"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { TTSManager, TTSProviderRegistry } = require("../lib/tts-core.js");
const {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_VOICE,
  createNovAIProvider
} = require("../lib/providers/novai.js");

function makeAudioBuffer() {
  return new Uint8Array([0x49, 0x44, 0x33, 0x04]).buffer;
}

test("TTSManager delegates provider-neutral synthesis and validates result", async () => {
  const calls = [];
  const registry = new TTSProviderRegistry().register("fake", {
    async synthesize(request) {
      calls.push(request);
      return { audio: makeAudioBuffer(), mimeType: "audio/mpeg" };
    }
  });
  const manager = new TTSManager({ registry, provider: "fake" });
  const controller = new AbortController();

  const result = await manager.synthesize({
    text: "Xin chào",
    voice: "voice-a",
    speed: 1.1,
    signal: controller.signal
  });

  assert.equal(result.audio.byteLength, 4);
  assert.equal(result.mimeType, "audio/mpeg");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    text: "Xin chào",
    voice: "voice-a",
    speed: 1.1,
    signal: controller.signal
  });
});

test("TTSManager surfaces provider errors unchanged", async () => {
  const expected = new Error("provider unavailable");
  const registry = new TTSProviderRegistry().register("fake", {
    async synthesize() {
      throw expected;
    }
  });
  const manager = new TTSManager({ registry, provider: "fake" });

  await assert.rejects(manager.synthesize({ text: "hello" }), (error) => error === expected);
});

test("TTSManager stops before provider call when signal is already aborted", async () => {
  let called = false;
  const registry = new TTSProviderRegistry().register("fake", {
    async synthesize() {
      called = true;
      return { audio: makeAudioBuffer(), mimeType: "audio/mpeg" };
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

test("TTSManager rejects malformed or empty provider audio", async () => {
  const registry = new TTSProviderRegistry().register("fake", {
    async synthesize() {
      return { audio: new ArrayBuffer(0), mimeType: "audio/mpeg" };
    }
  });
  const manager = new TTSManager({ registry, provider: "fake" });

  await assert.rejects(manager.synthesize({ text: "hello" }), /empty audio/i);
});

test("NovAI adapter owns endpoint, auth, defaults, request shape and response parsing", async () => {
  const controller = new AbortController();
  const requests = [];
  const provider = createNovAIProvider({
    apiKey: "test-key",
    fetch: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => name.toLowerCase() === "content-type" ? "audio/mpeg" : null },
        arrayBuffer: async () => makeAudioBuffer()
      };
    }
  });

  const result = await provider.synthesize({
    text: "Xin chào",
    speed: 1.05,
    signal: controller.signal
  });

  assert.equal(DEFAULT_BASE_URL, "https://aiapi-pro.com/v1");
  assert.equal(DEFAULT_MODEL, "minimax-speech-2.8-turbo");
  assert.equal(DEFAULT_VOICE, "male-qn-qingse");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://aiapi-pro.com/v1/audio/speech");
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.headers.Authorization, "Bearer test-key");
  assert.equal(requests[0].options.signal, controller.signal);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    model: "minimax-speech-2.8-turbo",
    input: "Xin chào",
    voice: "male-qn-qingse",
    response_format: "mp3",
    speed: 1.05
  });
  assert.equal(result.audio.byteLength, 4);
  assert.equal(result.mimeType, "audio/mpeg");
});

test("NovAI adapter allows voice override and reports provider errors without exposing key", async () => {
  const provider = createNovAIProvider({
    apiKey: "super-secret-key",
    fetch: async (_url, options) => {
      assert.equal(JSON.parse(options.body).voice, "custom-voice");
      return {
        ok: false,
        status: 401,
        headers: { get: () => "application/json" },
        text: async () => JSON.stringify({ error: { message: "invalid credentials" } })
      };
    }
  });

  await assert.rejects(
    provider.synthesize({ text: "hello", voice: "custom-voice" }),
    (error) => {
      assert.match(error.message, /401/);
      assert.match(error.message, /invalid credentials/);
      assert.doesNotMatch(error.message, /super-secret-key/);
      return true;
    }
  );
});
