"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function setup(adaptiveStartup = false) {
  let clockMs = 0;
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
  const speakerBatches = [];
  let handler;
  let finishFourth;
  const fourthAudio = new Promise((resolve) => { finishFourth = resolve; });
  let finishFifth;
  const fifthAudio = new Promise((resolve) => { finishFifth = resolve; });
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
    performance: { now: () => clockMs },
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
      { tStartMs: 3000, dDurationMs: 500, segs: [{ utf8: "Four." }] },
      { tStartMs: 4000, dDurationMs: 500, segs: [{ utf8: "Five." }] }
    ] }; } }),
    setInterval() {},
    setTimeout(callback) { timers.push(callback); },
    AbortController, URL, Set,
    SubToVoiceCaptionCore: require("../lib/caption-core.js"),
    SubToVoicePlaybackClock: require("../lib/playback-clock.js"),
    SubToVoicePlaybackSyncController: require("../lib/playback-sync-controller.js"),
    SubToVoiceAudioPreparation: require("../lib/audio-preparation.js"),
    SubToVoiceProviderClient: {
      async getRuntimeSettings() { return {
        sourceLanguage: "en", targetLanguage: "vi", multiVoice: true,
        speakerChunkSize: 2, multiVoiceLookaheadSeconds: 60, ttsConcurrency: 1,
        audioPreparation: { adaptiveStartup, groupedResume: true, startupSeconds: 4.5, resumeSeconds: 1.5, maxBufferSeconds: 4.5 }
      }; },
      async translateBatch({ lines }) { return lines; },
      async labelSpeakers({ lines }) {
        speakerBatches.push(lines.map((line) => line.id));
        return lines.map(() => "S1");
      },
      async synthesize({ text }) {
        synthesized.push(text);
        if (text === "Four.") await fourthAudio;
        if (text === "Five.") await fifthAudio;
        return { audio: new ArrayBuffer(8) };
      }
    },
    SubToVoiceAudioScheduler: {
      async decodeCompleteAudio() { return { duration: 1 }; },
      scheduleWindow(session, start, end) {
        scheduled.push([start, end]);
        for (let index = start; index < end; index += 1) {
          if (session.sentences[index]?._buffer) session.scheduledSentenceIndexes.add(index);
        }
        return [];
      },
      scheduleAroundPlayhead(session) {
        if (session.video.currentTime >= 4) return { start: 4, end: 5, scheduled: [] };
        for (let index = 0; index < 2; index += 1) session.scheduledSentenceIndexes.add(index);
        return { start: 0, end: 4, scheduled: [] };
      },
      cancelPendingSources(session) { session.scheduledSentenceIndexes.clear(); }
    }
  };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../content.js"), "utf8"), context);
  const send = (type) => new Promise((resolve) => handler({ type }, {}, resolve));

  return { video, listeners, timers, finishFourth, finishFifth, send,
    advanceClock: (ms) => { clockMs += ms; } };
}

async function flush() {
  for (let index = 0; index < 12; index += 1) await new Promise(setImmediate);
}

test("grouped resume waits through a missing next cue and resumes once the segment is ready", async () => {
  const { video, timers, finishFourth, finishFifth, send } = setup();
  assert.equal((await send("CONTENT_START")).ok, true);
  timers.shift()();
  await flush();
  video.currentTime = 2.6;
  timers.shift()();
  await flush();
  assert.equal(video.paused, true);
  finishFourth();
  await flush();
  assert.equal(video.paused, true, "one ready cue must not trigger early resume");
  finishFifth();
  await flush();
  assert.equal(video.paused, false);
  const log = (await send("CONTENT_GET_DIAGNOSTIC_LOG")).log;
  const resumes = log.events.filter((event) => event.type === "buffer_resume");
  assert.equal(resumes.length, 1);
  assert.ok(resumes[0].readySeconds >= resumes[0].targetSeconds);
  await send("CONTENT_STOP");
});

test("adaptive startup prepares the requested span before the first play", async () => {
  const { video, finishFourth, finishFifth, send } = setup(true);
  const started = send("CONTENT_START");
  await flush();
  assert.equal(video.paused, true);
  finishFourth();
  await flush();
  assert.equal(video.paused, true);
  finishFifth();
  assert.equal((await started).ok, true);
  assert.equal(video.paused, false);
  const log = (await send("CONTENT_GET_DIAGNOSTIC_LOG")).log;
  assert.ok(log.events.some((event) => event.type === "buffer_startup" && event.readySeconds >= 4));
  await send("CONTENT_STOP");
});

test("seek during grouped buffering changes the waiting cue and resumes at the new segment", async () => {
  const { video, listeners, timers, finishFourth, finishFifth, send } = setup();
  assert.equal((await send("CONTENT_START")).ok, true);
  timers.shift()();
  await flush();
  video.currentTime = 2.6;
  timers.shift()();
  await flush();
  assert.equal(video.paused, true);
  video.currentTime = 4;
  listeners.get("seeked")();
  await flush();
  assert.equal(video.paused, true);
  timers.shift()();
  await flush();
  finishFourth();
  finishFifth();
  await flush();
  assert.equal(video.paused, false);
  const log = (await send("CONTENT_GET_DIAGNOSTIC_LOG")).log;
  assert.ok(log.events.some((event) => event.type === "buffer_seek" && event.sentenceId === 5));
  await send("CONTENT_STOP");
});

test("resume budget releases playback with the current cue ready even while the next TTS is pending", async () => {
  const { video, timers, finishFourth, finishFifth, advanceClock, send } = setup();
  await send("CONTENT_START");
  timers.shift()();
  await flush();
  video.currentTime = 2.6;
  timers.shift()();
  await flush();
  advanceClock(4000);
  finishFourth();
  await flush();
  assert.equal(video.paused, true);
  advanceClock(1100);
  timers.shift()();
  await flush();
  assert.equal(video.paused, false);
  const log = (await send("CONTENT_GET_DIAGNOSTIC_LOG")).log;
  const wait = log.events.find((event) => event.type === "buffer_wait");
  const resume = log.events.find((event) => event.type === "buffer_resume");
  assert.equal(resume.deadlineReached, true);
  assert.equal(resume.ready, false);
  assert.equal(resume.targetSeconds, wait.targetSeconds);
  assert.ok(resume.waitedSeconds >= resume.waitBudgetSeconds);
  finishFifth();
  await send("CONTENT_STOP");
});

test("budget expiry never resumes before the required cue has audio", async () => {
  const { video, timers, finishFourth, finishFifth, advanceClock, send } = setup();
  await send("CONTENT_START");
  timers.shift()();
  await flush();
  video.currentTime = 2.6;
  timers.shift()();
  await flush();
  advanceClock(6000);
  timers.shift()();
  await flush();
  assert.equal(video.paused, true);
  finishFourth();
  await flush();
  assert.equal(video.paused, false);
  finishFifth();
  await send("CONTENT_STOP");
});
