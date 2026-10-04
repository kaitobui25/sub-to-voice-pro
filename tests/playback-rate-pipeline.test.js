"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("ratechange reuses decoded TTS buffers and retimes playback without re-synthesis", async () => {
  const listeners = new Map();
  const video = {
    paused: false,
    currentTime: 0,
    playbackRate: 1,
    volume: 1,
    muted: false,
    pause() { this.paused = true; listeners.get("pause")?.(); },
    async play() { this.paused = false; listeners.get("play")?.(); },
    addEventListener(name, handler) { listeners.set(name, handler); },
    removeEventListener(name, handler) {
      if (listeners.get(name) === handler) listeners.delete(name);
    }
  };

  const sources = [];
  class AudioContext {
    currentTime = 0;
    state = "running";
    destination = {};
    createGain() {
      return { gain: { value: 0 }, connect() {}, disconnect() {} };
    }
    createBufferSource() {
      const source = {
        playbackRate: {
          value: 1,
          setValueAtTime(value) { this.value = value; }
        },
        buffer: null,
        stopped: false,
        disconnected: false,
        startAt: null,
        onended: null,
        connect() {},
        start(at) { this.startAt = at; },
        stop() { this.stopped = true; },
        disconnect() { this.disconnected = true; }
      };
      sources.push(source);
      return source;
    }
    async decodeAudioData() { return { duration: 1 }; }
    async resume() { this.state = "running"; }
    async suspend() { this.state = "suspended"; }
    async close() { this.state = "closed"; }
  }

  let audioCtx;
  const OriginalAudioContext = AudioContext;
  class CapturedAudioContext extends OriginalAudioContext {
    constructor() {
      super();
      audioCtx = this;
    }
  }

  let messageHandler;
  let synthesizeCount = 0;
  const probe = { querySelector: () => ({ textContent: "" }), remove() {} };
  const context = {
    location: { href: "https://www.youtube.com/watch?v=test-video" },
    window: { AudioContext: CapturedAudioContext },
    document: {
      querySelector(selector) { return selector.includes("video") ? video : null; },
      querySelectorAll() { return [{ textContent: "var ytInitialPlayerResponse = " + JSON.stringify({
        captions: { playerCaptionsTracklistRenderer: { captionTracks: [{
          languageCode: "en",
          baseUrl: "https://www.youtube.com/api/timedtext?v=test-video"
        }] } }
      }) + ";" }]; },
      getElementById() { return probe; },
      documentElement: { appendChild() {} }
    },
    chrome: { runtime: {
      onMessage: { addListener(handler) { messageHandler = handler; } },
      sendMessage(_message, callback) { callback?.(null); return Promise.resolve(); }
    } },
    fetch: async () => ({ ok: true, async json() { return { events: [
      { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "Hello." }] },
      { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: "Next." }] }
    ] }; } }),
    setInterval() {},
    setTimeout() {},
    AbortController,
    URL,
    Set,
    Map,
    WeakMap,
    SubToVoiceCaptionCore: require("../lib/caption-core.js"),
    SubToVoicePlaybackClock: require("../lib/playback-clock.js"),
    SubToVoicePlaybackSyncController: require("../lib/playback-sync-controller.js"),
    SubToVoiceAudioPreparation: require("../lib/audio-preparation.js"),
    SubToVoiceAudioScheduler: require("../lib/audio-scheduler.js"),
    SubToVoiceProviderClient: {
      async getRuntimeSettings() {
        return {
          sourceLanguage: "en",
          targetLanguage: "vi",
          multiVoice: false,
          speed: 1,
          playbackSync: {
            lookaheadMs: 30000,
            lateThresholdMs: 500,
            startEpsilonMs: 20
          }
        };
      },
      async translateBatch({ lines }) { return lines; },
      async synthesize() {
        synthesizeCount += 1;
        return { audio: new ArrayBuffer(8) };
      }
    }
  };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../content.js"), "utf8"), context);
  const send = (type) => new Promise((resolve) => messageHandler({ type }, {}, resolve));

  assert.equal((await send("CONTENT_START")).ok, true);
  for (let index = 0; index < 4; index += 1) await new Promise(setImmediate);
  const synthesizedBeforeRateChange = synthesizeCount;
  assert.ok(synthesizedBeforeRateChange > 0);

  audioCtx.currentTime = 0.5;
  video.currentTime = 0.5;
  video.playbackRate = 2;
  listeners.get("ratechange")?.();
  for (let index = 0; index < 4; index += 1) await new Promise(setImmediate);

  assert.equal(synthesizeCount, synthesizedBeforeRateChange);
  assert.ok(sources.some((source) => !source.stopped && source.playbackRate.value === 2));
  await send("CONTENT_STOP");
});
