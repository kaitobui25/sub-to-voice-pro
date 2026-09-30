"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("multi-voice schedules each finished sentence without waiting for the rest of the TTS wave", async () => {
  const listeners = new Map();
  const video = {
    paused: false, currentTime: 0, volume: 1, muted: false,
    pause() { this.paused = true; listeners.get("pause")?.(); },
    async play() { this.paused = false; listeners.get("play")?.(); },
    addEventListener(name, handler) { listeners.set(name, handler); },
    removeEventListener(name) { listeners.delete(name); }
  };
  const timers = [];
  const scheduled = [];
  const synthesized = [];
  let handler;
  let finishFourth;
  const fourthAudio = new Promise((resolve) => { finishFourth = resolve; });
  class AudioContext {
    currentTime = 0;
    destination = {};
    createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; }
    async decodeAudioData() { return { duration: 1 }; }
    async resume() {}
    async suspend() {}
    async close() {}
  }
  const context = {
    location: { href: "https://www.youtube.com/watch?v=test-video" },
    window: { AudioContext },
    document: {
      querySelector(selector) { return selector.includes("video") ? video : null; },
      querySelectorAll() { return [{ textContent: "var ytInitialPlayerResponse = " + JSON.stringify({
        captions: { playerCaptionsTracklistRenderer: { captionTracks: [{
          languageCode: "en", kind: "asr", baseUrl: "https://www.youtube.com/api/timedtext?v=test-video&kind=asr"
        }] } }
      }) + ";" }]; },
      getElementById() { return { querySelector: () => ({ textContent: "" }), remove() {} }; },
      documentElement: { appendChild() {} }
    },
    chrome: { runtime: {
      onMessage: { addListener(callback) { handler = callback; } },
      sendMessage(_message, callback) { callback?.(null); return Promise.resolve(); }
    } },
    fetch: async () => ({ ok: true, async json() { return { events: [
      { tStartMs: 0, dDurationMs: 500, segs: [{ utf8: "One." }] },
      { tStartMs: 1000, dDurationMs: 500, segs: [{ utf8: "Two." }] },
      { tStartMs: 2000, dDurationMs: 500, segs: [{ utf8: "Three." }] },
      { tStartMs: 3000, dDurationMs: 500, segs: [{ utf8: "Four." }] }
    ] }; } }),
    setInterval() {},
    setTimeout(callback) { timers.push(callback); },
    AbortController, URL, Set,
    SubToVoiceCaptionCore: require("../lib/caption-core.js"),
    SubToVoiceProviderClient: {
      async getRuntimeSettings() { return {
        sourceLanguage: "en", targetLanguage: "vi", multiVoice: true,
        speakerChunkSize: 2, multiVoiceLookaheadSeconds: 60, ttsConcurrency: 1
      }; },
      async translateBatch({ lines }) { return lines; },
      async labelSpeakers({ lines }) { return lines.map(() => "S1"); },
      async synthesize({ text }) {
        synthesized.push(text);
        if (text === "Four.") await fourthAudio;
        return { audio: new ArrayBuffer(8) };
      }
    },
    SubToVoiceAudioScheduler: {
      LOOKAHEAD_MS: 30000, LATE_CUE_THRESHOLD_SEC: 0.5,
      async decodeCompleteAudio() { return { duration: 1 }; },
      computeAudioOffset() { return 0; },
      scheduleWindow(session, start, end) {
        scheduled.push([start, end]);
        for (let index = start; index < end; index += 1) {
          if (session.sentences[index]?._buffer) session.scheduledSentenceIndexes.add(index);
        }
        return [];
      },
      scheduleAroundPlayhead(session) {
        for (let index = 0; index < 2; index += 1) session.scheduledSentenceIndexes.add(index);
        return { start: 0, end: 4, scheduled: [] };
      },
      cancelPendingSources(session) { session.scheduledSentenceIndexes.clear(); }
    }
  };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../content.js"), "utf8"), context);
  const send = (type) => new Promise((resolve) => handler({ type }, {}, resolve));

  assert.equal((await send("CONTENT_START")).ok, true);
  assert.ok(timers.length);
  timers.shift()();
  for (let index = 0; index < 12; index += 1) await new Promise(setImmediate);
  video.currentTime = 4;
  const snapshot = (await send("CONTENT_GET_TRANSCRIPT")).transcript;
  assert.ok(scheduled.some(([start, end]) => start === 2 && end === 3),
    JSON.stringify({ scheduled, synthesized, timers: timers.length, paused: video.paused,
      rows: snapshot.rows.map((row) => [row.id, row.translation, row.diagnostic]) }));
  assert.equal(scheduled.some(([start]) => start === 3), false);

  video.currentTime = 2.6;
  timers.shift()();
  for (let index = 0; index < 4; index += 1) await new Promise(setImmediate);
  assert.equal(video.paused, true);

  finishFourth();
  for (let index = 0; index < 4; index += 1) await new Promise(setImmediate);
  assert.equal(video.paused, false);
  assert.ok(scheduled.some(([start, end]) => start === 3 && end === 4));
  video.currentTime = 4;
  const resumed = (await send("CONTENT_GET_TRANSCRIPT")).transcript.rows.find((row) => row.id === 4);
  assert.equal(typeof resumed.diagnostic.waitStart, "number");
  assert.equal(typeof resumed.diagnostic.waitEnd, "number");
  await send("CONTENT_STOP");
});
