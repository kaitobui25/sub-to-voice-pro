"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createVieNeuTTSProvider,
  repairStreamingWavHeader
} = require("../lib/providers/vieneu.js");

function makeStreamingWav() {
  const bytes = new Uint8Array(48);
  bytes.set(Buffer.from("RIFF"), 0);
  new DataView(bytes.buffer).setUint32(4, 0xFFFFFFFF, true);
  bytes.set(Buffer.from("WAVE"), 8);
  bytes.set(Buffer.from("fmt "), 12);
  new DataView(bytes.buffer).setUint32(16, 16, true);
  bytes.set(Buffer.from("data"), 36);
  new DataView(bytes.buffer).setUint32(40, 0xFFFFFFFF, true);
  bytes.set([1, 2, 3, 4], 44);
  return bytes.buffer;
}

test("VieNeu adapter sends configured OpenAI-compatible speech request and returns repaired WAV", async () => {
  const calls = [];
  const provider = createVieNeuTTSProvider({
    baseUrl: "http://127.0.0.1:8000/v1/",
    model: "model-from-config",
    voice: "Hải Đăng",
    sampleRate: 48000,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => name === "content-type" ? "audio/wav" : null },
        async arrayBuffer() {
          return makeStreamingWav();
        }
      };
    }
  });

  const result = await provider.synthesize({ text: "Xin chào.", speed: 1 });
  assert.equal(calls[0].url, "http://127.0.0.1:8000/v1/audio/speech");
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body, {
    model: "model-from-config",
    input: "Xin chào.",
    voice: "Hải Đăng",
    response_format: "wav",
    stream_format: "audio",
    sample_rate: 48000
  });
  assert.equal(result.mimeType, "audio/wav");
  assert.equal(result.model, "model-from-config");
  const view = new DataView(result.audio);
  assert.equal(view.getUint32(4, true), result.audio.byteLength - 8);
  assert.equal(view.getUint32(40, true), result.audio.byteLength - 44);
});

test("VieNeu WAV repair leaves non-WAV buffers untouched", () => {
  const input = new Uint8Array([1, 2, 3, 4]).buffer;
  assert.equal(repairStreamingWavHeader(input), input);
});

test("VieNeu adapter rejects speed changes because the current local server ignores speed", async () => {
  const provider = createVieNeuTTSProvider({
    baseUrl: "http://127.0.0.1:8000/v1",
    model: "model",
    voice: "voice",
    sampleRate: 48000,
    fetchImpl: async () => { throw new Error("must not call"); }
  });
  await assert.rejects(
    provider.synthesize({ text: "Xin chào.", speed: 1.2 }),
    /requires speed=1/
  );
});

test("VieNeu adapter surfaces local API errors", async () => {
  const provider = createVieNeuTTSProvider({
    baseUrl: "http://127.0.0.1:8000/v1",
    model: "model",
    voice: "voice",
    sampleRate: 48000,
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      async text() {
        return JSON.stringify({ error: { message: "server busy" } });
      }
    })
  });
  await assert.rejects(provider.synthesize({ text: "Xin chào.", speed: 1 }), /429.*server busy/i);
});

test("VieNeu adapter retries a busy stream slot and returns audio", async () => {
  let calls = 0;
  const provider = createVieNeuTTSProvider({
    baseUrl: "http://127.0.0.1:8000/v1",
    model: "model", voice: "voice", sampleRate: 48000,
    busyRetryTimeoutMs: 1000, busyRetryDelayMs: 1,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return {
        ok: false, status: 429, headers: { get: () => null },
        async text() { return "server busy"; }
      };
      return {
        ok: true, status: 200, headers: { get: () => "audio/wav" },
        async arrayBuffer() { return makeStreamingWav(); }
      };
    }
  });
  const result = await provider.synthesize({ text: "hello" });
  assert.equal(calls, 2);
  assert.equal(result.mimeType, "audio/wav");
});

test("VieNeu busy retry stops when synthesis is cancelled", async () => {
  const controller = new AbortController();
  let calls = 0;
  const provider = createVieNeuTTSProvider({
    baseUrl: "http://127.0.0.1:8000/v1",
    model: "model", voice: "voice", sampleRate: 48000,
    busyRetryTimeoutMs: 5000, busyRetryDelayMs: 1000,
    fetchImpl: async () => {
      calls += 1;
      queueMicrotask(() => controller.abort());
      return { ok: false, status: 429, headers: { get: () => null } };
    }
  });
  await assert.rejects(provider.synthesize({ text: "hello", signal: controller.signal }), { name: "AbortError" });
  assert.equal(calls, 1);
});
