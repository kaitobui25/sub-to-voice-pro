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
  const speakerBatches = [];
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
    SubToVoicePlaybackClock: require("../lib/playback-clock.js"),
    SubToVoicePlaybackSyncController: require("../lib/playback-sync-controller.js"),
    SubToVoiceProviderClient: {
      async getRuntimeSettings() { return {
        sourceLanguage: "en", targetLanguage: "vi", multiVoice: true,
        speakerChunkSize: 2, multiVoiceLookaheadSeconds: 60, ttsConcurrency: 1
      }; },
      async translateBatch({ lines }) { return lines; },
      async labelSpeakers({ lines }) {
        speakerBatches.push(lines.map((line) => line.id));
        return lines.map(() => "S1");
      },
      async synthesize({ text }) {
        synthesized.push(text);
        if (text === "Four.") await fourthAudio;
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
  assert.deepEqual(speakerBatches, [[1, 2, 3, 4]]);
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

  const waitingLog = (await send("CONTENT_GET_DIAGNOSTIC_LOG")).log;
  assert.ok(waitingLog.events.some((event) => event.type === "pause_requested" &&
    event.reason === "audio_not_ready" && event.sentenceId === 4));
  assert.equal(waitingLog.sentences.find((row) => row.id === 4).audioReady, false);

  finishFourth();
  for (let index = 0; index < 4; index += 1) await new Promise(setImmediate);
  assert.equal(video.paused, false);
  assert.ok(scheduled.some(([start, end]) => start === 3 && end === 4));
  video.currentTime = 4;
  const resumed = (await send("CONTENT_GET_TRANSCRIPT")).transcript.rows.find((row) => row.id === 4);
  assert.equal(typeof resumed.diagnostic.waitStart, "number");
  assert.equal(typeof resumed.diagnostic.waitEnd, "number");
  const detailed = (await send("CONTENT_GET_DIAGNOSTIC_LOG")).log;
  assert.ok(detailed.events.some((event) => event.type === "play_resolved" &&
    event.reason === "resume_waiting_audio"));
  for (let index = 0; index < detailed.eventLimit + 5; index += 1) listeners.get("waiting")();
  const bounded = (await send("CONTENT_GET_DIAGNOSTIC_LOG")).log;
  assert.equal(bounded.events.length, bounded.eventLimit);
  assert.ok(bounded.droppedEvents > 0);
  assert.equal(bounded.events[0].sequence, bounded.droppedEvents + 1);
  assert.ok(bounded.events.every((event, index) => index === 0 ||
    event.sequence === bounded.events[index - 1].sequence + 1));
  await send("CONTENT_STOP");
  const stopped = (await send("CONTENT_GET_DIAGNOSTIC_LOG")).log;
  assert.equal(stopped.events.at(-1).type, "session_stop");
});

test("full-transcript speaker labeling splits only when the configured request limit is reached", async () => {
  const listeners = new Map();
  const video = {
    paused: true, currentTime: 0, volume: 1, muted: false,
    pause() { this.paused = true; listeners.get("pause")?.(); },
    async play() { this.paused = false; listeners.get("play")?.(); },
    addEventListener(name, handler) { listeners.set(name, handler); },
    removeEventListener(name) { listeners.delete(name); }
  };
  let handler;
  const batches = [];
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
    location: { href: "https://www.youtube.com/watch?v=test-video" }, window: { AudioContext },
    document: {
      querySelector(selector) { return selector.includes("video") ? video : null; },
      querySelectorAll() { return [{ textContent: "var ytInitialPlayerResponse = " + JSON.stringify({
        captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: "en", kind: "asr", baseUrl: "https://www.youtube.com/api/timedtext?v=test-video&kind=asr" }] } }
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
    setInterval() {}, setTimeout() {}, AbortController, URL, Set, Map, Date,
    SubToVoiceCaptionCore: require("../lib/caption-core.js"),
    SubToVoicePlaybackClock: require("../lib/playback-clock.js"),
    SubToVoicePlaybackSyncController: require("../lib/playback-sync-controller.js"),
    SubToVoiceProviderClient: {
      async getRuntimeSettings() { return {
        sourceLanguage: "en", targetLanguage: "vi", multiVoice: true,
        speakerVoiceCount: 2, speakerMaxLinesPerRequest: 2, speakerMaxPromptChars: 60000,
        speakerContextSize: 1, renderBatchSize: 2, ttsConcurrency: 1
      }; },
      async translateBatch({ lines }) { return lines; },
      async labelSpeakers({ lines, context }) {
        batches.push({ ids: lines.map((line) => line.id), context: context.map((item) => [item.id, item.speaker]) });
        return lines.map((line) => line.id % 2 ? "S1" : "S2");
      },
      async synthesize() { return { audio: new ArrayBuffer(8) }; }
    },
    SubToVoiceAudioScheduler: {
      async decodeCompleteAudio() { return { duration: 1 }; },
      scheduleWindow(session, start, end) { for (let i = start; i < end; i += 1) if (session.sentences[i]?._buffer) session.scheduledSentenceIndexes.add(i); return []; },
      scheduleAroundPlayhead() { return { start: 0, end: 2, scheduled: [] }; },
      cancelPendingSources(session) { session.scheduledSentenceIndexes.clear(); }
    }
  };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../content.js"), "utf8"), context);
  const send = (type) => new Promise((resolve) => handler({ type }, {}, resolve));
  assert.equal((await send("CONTENT_START")).ok, true);
  assert.equal(JSON.stringify(batches), JSON.stringify([
    { ids: [1, 2], context: [] },
    { ids: [3, 4], context: [[2, "S2"]] },
    { ids: [5], context: [[4, "S2"]] }
  ]));
  const transcript = (await send("CONTENT_GET_TRANSCRIPT")).transcript;
  assert.equal(transcript.speakerRequestCount, 3);
  assert.equal(transcript.speakerFallbackBatchCount, 0);
  await send("CONTENT_STOP");
});

test("multi-voice startup reports Paused when the YouTube video was already paused", async () => {
  const listeners = new Map();
  const video = {
    paused: true, currentTime: 0, volume: 1, muted: false,
    pause() { this.paused = true; listeners.get("pause")?.(); },
    async play() { this.paused = false; listeners.get("play")?.(); },
    addEventListener(name, handler) { listeners.set(name, handler); },
    removeEventListener(name) { listeners.delete(name); }
  };
  let handler;
  const states = [];
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
      sendMessage(message, callback) { if (message?.type === "CONTENT_STATE") states.push(message); callback?.(null); return Promise.resolve(); }
    } },
    fetch: async () => ({ ok: true, async json() { return { events: [
      { tStartMs: 0, dDurationMs: 500, segs: [{ utf8: "One." }] }
    ] }; } }),
    setInterval() {}, setTimeout() {}, AbortController, URL, Set,
    SubToVoiceCaptionCore: require("../lib/caption-core.js"),
    SubToVoicePlaybackClock: require("../lib/playback-clock.js"),
    SubToVoicePlaybackSyncController: require("../lib/playback-sync-controller.js"),
    SubToVoiceProviderClient: {
      async getRuntimeSettings() { return { sourceLanguage: "en", targetLanguage: "vi", multiVoice: true, speakerChunkSize: 2, ttsConcurrency: 1 }; },
      async translateBatch({ lines }) { return lines; },
      async labelSpeakers({ lines }) { return lines.map(() => "S1"); },
      async synthesize() { return { audio: new ArrayBuffer(8) }; }
    },
    SubToVoiceAudioScheduler: {
      async decodeCompleteAudio() { return { duration: 1 }; },
      scheduleWindow(session, start, end) { for (let i = start; i < end; i += 1) if (session.sentences[i]?._buffer) session.scheduledSentenceIndexes.add(i); return []; },
      scheduleAroundPlayhead() { return { start: 0, end: 1, scheduled: [] }; },
      cancelPendingSources(session) { session.scheduledSentenceIndexes.clear(); }
    }
  };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../content.js"), "utf8"), context);
  const result = await new Promise((resolve) => handler({ type: "CONTENT_START" }, {}, resolve));
  assert.equal(result.ok, true);
  assert.equal(result.status, "Paused");
  assert.equal(video.paused, true);
  assert.equal(states.at(-1)?.status, "Paused");
  assert.equal(states.at(-1)?.paused, true);
});

test("multi-voice startup includes a caption already active at the playhead", async () => {
  const listeners = new Map();
  const video = {
    paused: true, currentTime: 0.3, volume: 1, muted: false,
    pause() { this.paused = true; listeners.get("pause")?.(); },
    async play() { this.paused = false; listeners.get("play")?.(); },
    addEventListener(name, handler) { listeners.set(name, handler); },
    removeEventListener(name) { listeners.delete(name); }
  };
  let handler;
  const synthesized = [];
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
    location: { href: "https://www.youtube.com/watch?v=test-video" }, window: { AudioContext },
    document: {
      querySelector(selector) { return selector.includes("video") ? video : null; },
      querySelectorAll() { return [{ textContent: "var ytInitialPlayerResponse = " + JSON.stringify({
        captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: "en", kind: "asr", baseUrl: "https://www.youtube.com/api/timedtext?v=test-video&kind=asr" }] } }
      }) + ";" }]; },
      getElementById() { return { querySelector: () => ({ textContent: "" }), remove() {} }; },
      documentElement: { appendChild() {} }
    },
    chrome: { runtime: {
      onMessage: { addListener(callback) { handler = callback; } },
      sendMessage(_message, callback) { callback?.(null); return Promise.resolve(); }
    } },
    fetch: async () => ({ ok: true, async json() { return { events: [
      { tStartMs: 0, dDurationMs: 500, segs: [{ utf8: "Active." }] }
    ] }; } }),
    setInterval() {}, setTimeout() {}, AbortController, URL, Set,
    SubToVoiceCaptionCore: require("../lib/caption-core.js"),
    SubToVoicePlaybackClock: require("../lib/playback-clock.js"),
    SubToVoicePlaybackSyncController: require("../lib/playback-sync-controller.js"),
    SubToVoiceProviderClient: {
      async getRuntimeSettings() { return { sourceLanguage: "en", targetLanguage: "vi", multiVoice: true, speakerChunkSize: 2, ttsConcurrency: 1 }; },
      async translateBatch({ lines }) { return lines.map(() => "Dang noi."); },
      async labelSpeakers({ lines }) { return lines.map(() => "S1"); },
      async synthesize({ text }) { synthesized.push(text); return { audio: new ArrayBuffer(8) }; }
    },
    SubToVoiceAudioScheduler: {
      async decodeCompleteAudio() { return { duration: 1 }; },
      scheduleWindow(session, start, end) { for (let i = start; i < end; i += 1) if (session.sentences[i]?._buffer) session.scheduledSentenceIndexes.add(i); return []; },
      scheduleAroundPlayhead() { return { start: 0, end: 1, scheduled: [] }; },
      cancelPendingSources(session) { session.scheduledSentenceIndexes.clear(); }
    }
  };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../content.js"), "utf8"), context);
  const result = await new Promise((resolve) => handler({ type: "CONTENT_START" }, {}, resolve));
  assert.equal(result.ok, true);
  assert.deepEqual(synthesized, ["Dang noi."]);
});

test("multi-voice skips a materially late buffered cue instead of pausing forever", async () => {
  const listeners = new Map();
  const timers = [];
  const video = {
    paused: false, currentTime: 0.75, volume: 1, muted: false,
    pause() { this.paused = true; listeners.get("pause")?.(); },
    async play() { this.paused = false; listeners.get("play")?.(); },
    addEventListener(name, handler) { listeners.set(name, handler); },
    removeEventListener(name) { listeners.delete(name); }
  };
  let handler;
  class AudioContext {
    currentTime = 0;
    destination = {};
    createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; }
    async decodeAudioData() { return { duration: 1 }; }
    async resume() {}
    async suspend() {}
    async close() {}
  }
  const scheduler = {
    async decodeCompleteAudio() { return { duration: 1 }; },
    scheduleWindow(session, start, end, options) {
      for (let i = start; i < end; i += 1) {
        const sentence = session.sentences[i];
        if (!sentence?._buffer) continue;
        if (sentence.start < session.video.currentTime - 0.5) {
          options?.onDecision?.({ index: i, status: "late", videoTime: session.video.currentTime });
          continue;
        }
        session.scheduledSentenceIndexes.add(i);
      }
      return [];
    },
    scheduleAroundPlayhead(session, _video, options) {
      scheduler.scheduleWindow(session, 0, 2, options);
      return { start: 0, end: 2, scheduled: [] };
    },
    cancelPendingSources(session) { session.scheduledSentenceIndexes.clear(); }
  };
  const context = {
    location: { href: "https://www.youtube.com/watch?v=test-video" }, window: { AudioContext },
    document: {
      querySelector(selector) { return selector.includes("video") ? video : null; },
      querySelectorAll() { return [{ textContent: "var ytInitialPlayerResponse = " + JSON.stringify({
        captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: "en", kind: "asr", baseUrl: "https://www.youtube.com/api/timedtext?v=test-video&kind=asr" }] } }
      }) + ";" }]; },
      getElementById() { return { querySelector: () => ({ textContent: "" }), remove() {} }; },
      documentElement: { appendChild() {} }
    },
    chrome: { runtime: {
      onMessage: { addListener(callback) { handler = callback; } },
      sendMessage(_message, callback) { callback?.(null); return Promise.resolve(); }
    } },
    fetch: async () => ({ ok: true, async json() { return { events: [
      { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "Late." }] },
      { tStartMs: 1200, dDurationMs: 500, segs: [{ utf8: "Next." }] }
    ] }; } }),
    setInterval() {}, setTimeout(callback) { timers.push(callback); }, AbortController, URL, Set,
    SubToVoiceCaptionCore: require("../lib/caption-core.js"),
    SubToVoicePlaybackClock: require("../lib/playback-clock.js"),
    SubToVoicePlaybackSyncController: require("../lib/playback-sync-controller.js"),
    SubToVoiceProviderClient: {
      async getRuntimeSettings() { return { sourceLanguage: "en", targetLanguage: "vi", multiVoice: true, speakerChunkSize: 2, multiVoiceLookaheadSeconds: 60, ttsConcurrency: 1 }; },
      async translateBatch({ lines }) { return lines; }, async labelSpeakers({ lines }) { return lines.map(() => "S1"); },
      async synthesize() { return { audio: new ArrayBuffer(8) }; }
    },
    SubToVoiceAudioScheduler: scheduler
  };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../content.js"), "utf8"), context);
  assert.equal((await new Promise((resolve) => handler({ type: "CONTENT_START" }, {}, resolve))).ok, true);
  assert.ok(timers.length);
  timers.shift()();
  for (let i = 0; i < 4; i += 1) await new Promise(setImmediate);
  assert.equal(video.paused, false);
});

test("speaker labeling failure falls back quickly to two stable voices", async () => {
  const listeners = new Map();
  const video = {
    paused: true, currentTime: 0, volume: 1, muted: false,
    pause() { this.paused = true; listeners.get("pause")?.(); },
    async play() { this.paused = false; listeners.get("play")?.(); },
    addEventListener(name, handler) { listeners.set(name, handler); },
    removeEventListener(name) { listeners.delete(name); }
  };
  let handler;
  const speakers = [];
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
    location: { href: "https://www.youtube.com/watch?v=test-video" }, window: { AudioContext },
    document: {
      querySelector(selector) { return selector.includes("video") ? video : null; },
      querySelectorAll() { return [{ textContent: "var ytInitialPlayerResponse = " + JSON.stringify({
        captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: "en", kind: "asr", baseUrl: "https://www.youtube.com/api/timedtext?v=test-video&kind=asr" }] } }
      }) + ";" }]; },
      getElementById() { return { querySelector: () => ({ textContent: "" }), remove() {} }; },
      documentElement: { appendChild() {} }
    },
    chrome: { runtime: {
      onMessage: { addListener(callback) { handler = callback; } },
      sendMessage(_message, callback) { callback?.(null); return Promise.resolve(); }
    } },
    fetch: async () => ({ ok: true, async json() { return { events: [
      { tStartMs: 0, dDurationMs: 900, segs: [{ utf8: "good morning I'm John the marketing manager." }] },
      { tStartMs: 1000, dDurationMs: 900, segs: [{ utf8: "thanks for coming in today good morning John I'm Sarah." }] }
    ] }; } }),
    setInterval() {}, setTimeout() {}, AbortController, URL, Set, Map, Date,
    SubToVoiceCaptionCore: require("../lib/caption-core.js"),
    SubToVoicePlaybackClock: require("../lib/playback-clock.js"),
    SubToVoicePlaybackSyncController: require("../lib/playback-sync-controller.js"),
    SubToVoiceProviderClient: {
      async getRuntimeSettings() { return { sourceLanguage: "en", targetLanguage: "vi", multiVoice: true, speakerVoiceCount: 2, speakerChunkSize: 8, ttsConcurrency: 1 }; },
      async translateBatch({ lines }) { return lines; },
      async labelSpeakers() { throw new Error("Speaker labeling timed out."); },
      async synthesize({ speaker }) { speakers.push(speaker); return { audio: new ArrayBuffer(8) }; }
    },
    SubToVoiceAudioScheduler: {
      async decodeCompleteAudio() { return { duration: 1 }; },
      scheduleWindow(session, start, end) { for (let i = start; i < end; i += 1) if (session.sentences[i]?._buffer) session.scheduledSentenceIndexes.add(i); return []; },
      scheduleAroundPlayhead() { return { start: 0, end: 2, scheduled: [] }; },
      cancelPendingSources(session) { session.scheduledSentenceIndexes.clear(); }
    }
  };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../content.js"), "utf8"), context);
  const result = await new Promise((resolve) => handler({ type: "CONTENT_START" }, {}, resolve));
  assert.equal(result.ok, true);
  assert.deepEqual(speakers, ["S1", "S2"]);
});
