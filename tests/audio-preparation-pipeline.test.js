"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function setup(adaptiveStartup = false, preparation = {}, synthesisDurations = {}, captionStarts = [0, 1, 2, 3, 4]) {
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
    ].map((event, index) => ({ ...event, tStartMs: captionStarts[index] * 1000 })) }; } }),
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
        audioPreparation: { adaptiveStartup, groupedResume: true, startupSeconds: 4.5, resumeSeconds: 1.5, maxBufferSeconds: 4.5, ...preparation }
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
        clockMs += synthesisDurations[text] || 0;
        return { audio: new ArrayBuffer(8) };
      }
    },
    SubToVoiceAudioScheduler: {
      async decodeCompleteAudio() { return { duration: 1, length: 100, numberOfChannels: 1 }; },
      scheduleWindow(session, start, end) {
        scheduled.push([start, end]);
        for (let index = start; index < end; index += 1) {
          if (session.sentences[index]?._buffer) session.scheduledSentenceIndexes.add(index);
        }
        return [];
      },
      scheduleAroundPlayhead(session) {
        const window = require("../lib/audio-scheduler.js").findScheduleWindow(
          session.sentences, session.video.currentTime, 30000);
        for (let index = window.start; index < window.end; index += 1) {
          if (session.sentences[index]?._buffer && !session.scheduledSentenceIndexes.has(index)) {
            scheduled.push([index, index + 1]);
            session.scheduledSentenceIndexes.add(index);
          }
        }
        return { ...window, scheduled: [] };
      },
      cancelPendingSources(session) { session.scheduledSentenceIndexes.clear(); }
    }
  };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../content.js"), "utf8"), context);
  const send = (type) => new Promise((resolve) => handler({ type }, {}, resolve));

  return { video, listeners, timers, finishFourth, finishFifth, send, synthesized, scheduled,
    advanceClock: (ms) => { clockMs += ms; } };
}

async function flush() {
  for (let index = 0; index < 12; index += 1) await new Promise(setImmediate);
}

test("a finished future TTS cue does not jump ahead of cached audio near the playhead", async () => {
  const { video, timers, scheduled, send } = setup(false, {}, {}, [0, 1, 60, 61, 62]);
  await send("CONTENT_START");
  timers.shift()();
  await flush();
  const log = (await send("CONTENT_GET_DIAGNOSTIC_LOG")).log;
  assert.equal(log.sentences[2].audioReady, true, "lookahead synthesis may prepare a distant cue");
  assert.equal(scheduled.some(([start]) => start === 2), false, "distant audio must wait outside the scheduling window");
  video.currentTime = 59.6;
  timers.shift()();
  await flush();
  assert.equal(scheduled.some(([start]) => start === 2), true);
  await send("CONTENT_STOP");
});

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

test("startup waits for the complete requested audio span even beyond its old time budget", async () => {
  const { video, finishFourth, finishFifth, send, advanceClock } = setup(true);
  const started = send("CONTENT_START");
  await flush();
  assert.equal(video.paused, true);
  advanceClock(60000);
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

test("startup expands its audio target when measured synthesis is slow and keeps that target stable", async () => {
  const { video, finishFourth, finishFifth, send } = setup(true, {
    startupSeconds: 2.5, estimationMinVideoSeconds: 0.5
  }, { "One.": 100, "Two.": 100, "Three.": 2000, "Four.": 100, "Five.": 100 });
  const started = send("CONTENT_START");
  await flush();
  assert.equal(video.paused, true, "the original 2.5-second buffer is too small after measuring slow TTS");
  finishFourth();
  await flush();
  assert.equal(video.paused, true, "one faster cue must not reduce the committed startup target");
  finishFifth();
  assert.equal((await started).ok, true);
  const log = (await send("CONTENT_GET_DIAGNOSTIC_LOG")).log;
  const startup = log.events.find((event) => event.type === "buffer_startup");
  assert.equal(startup.targetSeconds, 4.5);
  assert.equal(startup.ready, true);
  await send("CONTENT_STOP");
});

test("queued Vietnamese audio is retained instead of skipping late sentences", async () => {
  const { video, timers, finishFourth, finishFifth, send, synthesized } = setup(false, { retainPastSeconds: 1 });
  await send("CONTENT_START");
  timers.shift()();
  await flush();
  timers.shift()();
  await flush();
  video.currentTime = 20;
  video.pause();
  finishFourth();
  await flush();
  assert.ok(synthesized.includes("Five."), "queued audio must not be dropped because it is late");
  finishFifth();
  await flush();
  timers.shift()();
  await flush();
  const log = (await send("CONTENT_GET_DIAGNOSTIC_LOG")).log;
  assert.equal(log.events.some((event) => event.type === "tts_skipped"), false);
  assert.equal(log.resources.cachedAudioBytes, 0);
  assert.equal(video.paused, true, "TTS completion must preserve a user pause");
  await send("CONTENT_STOP");
});

test("ON starts playback after preparation even if the video was initially paused", async () => {
  const { video, send } = setup();
  video.paused = true;
  assert.equal((await send("CONTENT_START")).ok, true);
  assert.equal(video.paused, false);
  video.pause();
  assert.equal(video.paused, true);
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

test("resume deadline does not release playback until the following audio span is ready", async () => {
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
  assert.equal(video.paused, true);
  finishFifth();
  await flush();
  assert.equal(video.paused, false);
  const log = (await send("CONTENT_GET_DIAGNOSTIC_LOG")).log;
  const wait = log.events.find((event) => event.type === "buffer_wait");
  const resume = log.events.find((event) => event.type === "buffer_resume");
  assert.equal(resume.ready, true);
  assert.equal(resume.targetSeconds, wait.targetSeconds);
  assert.ok(resume.waitedSeconds >= 5);
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
  assert.equal(video.paused, true);
  finishFifth();
  await flush();
  assert.equal(video.paused, false);
  await send("CONTENT_STOP");
});
