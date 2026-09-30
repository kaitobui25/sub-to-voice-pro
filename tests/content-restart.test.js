"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("Stop then Start reuses captions already fetched for the same video", async () => {
  const video = {
    paused: true, currentTime: 0, volume: 1, muted: false,
    addEventListener() {}, removeEventListener() {}
  };
  const script = {
    textContent: "var ytInitialPlayerResponse = " + JSON.stringify({
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [{
        languageCode: "en", kind: "asr", baseUrl: "https://www.youtube.com/api/timedtext?v=test-video&kind=asr"
      }] } }
    }) + ";"
  };
  const probe = { querySelector: () => ({ textContent: "" }), remove() {} };
  let messageHandler;
  let fetchCount = 0;
  class AudioContext {
    currentTime = 0;
    destination = {};
    createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; }
    close() { return Promise.resolve(); }
  }
  const context = {
    location: { href: "https://www.youtube.com/watch?v=test-video" },
    window: { AudioContext },
    document: {
      querySelector(selector) { return selector.includes("video") ? video : null; },
      querySelectorAll() { return [script]; },
      getElementById() { return probe; },
      documentElement: { appendChild() {} }
    },
    chrome: { runtime: {
      onMessage: { addListener(handler) { messageHandler = handler; } },
      sendMessage(message, callback) { if (callback) callback(null); else return Promise.resolve(); }
    } },
    fetch: async () => {
      fetchCount += 1;
      if (fetchCount > 1) throw new Error("YouTube did not serve captions again");
      return { ok: true, async json() { return { events: [
        { tStartMs: 0, dDurationMs: 500, segs: [{ utf8: "Hello." }] },
        { tStartMs: 40000, dDurationMs: 500, segs: [{ utf8: "Later." }] }
      ] }; } };
    },
    setInterval() {},
    setTimeout() {},
    AbortController,
    URL,
    Set,
    SubToVoiceCaptionCore: require("../lib/caption-core.js"),
    SubToVoiceProviderClient: {
      async getRuntimeSettings() { return { targetLanguage: "vi", sourceLanguage: "en" }; },
      async translateBatch({ lines }) { return lines; },
      async synthesize() { return { audio: new ArrayBuffer(8) }; }
    },
    SubToVoiceAudioScheduler: {
      LOOKAHEAD_MS: 30000,
      async decodeCompleteAudio() { return {}; },
      computeAudioOffset() { return 0; },
      scheduleWindow() {}, cancelPendingSources() {}
    }
  };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../content.js"), "utf8"), context);
  const send = (type) => new Promise((resolve) => messageHandler({ type }, {}, resolve));

  assert.equal((await send("CONTENT_START")).ok, true);
  const transcript = (await send("CONTENT_GET_TRANSCRIPT")).transcript;
  assert.equal(transcript.rows.length, 2);
  assert.equal(transcript.rows[0].originals[0].text, "Hello.");
  assert.equal(transcript.rows[1].originals[0].start, 40);
  assert.equal(transcript.rows[1].translation, null);
  assert.deepEqual(Array.from(transcript.rows[1].audio), []);
  await new Promise((resolve) => messageHandler({ type: "CONTENT_SET_ORIGINAL_VOLUME", volume: 35 }, {}, resolve));
  assert.equal(video.volume, 0.35);
  assert.equal((await send("CONTENT_STOP")).ok, true);
  assert.equal(video.volume, 1);
  assert.equal((await send("CONTENT_START")).ok, true);
  assert.equal(fetchCount, 1);
  await send("CONTENT_STOP");
});
