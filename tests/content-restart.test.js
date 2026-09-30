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
  let multiVoice = false;
  const speakerRequests = [];
  const synthesisSpeakers = [];
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
        { tStartMs: 40000, dDurationMs: 500, segs: [{ utf8: "Later." }] },
        { tStartMs: 80000, dDurationMs: 500, segs: [{ utf8: "Much later." }] }
      ] }; } };
    },
    setInterval() {},
    setTimeout() {},
    AbortController,
    URL,
    Set,
    SubToVoiceCaptionCore: require("../lib/caption-core.js"),
    SubToVoiceProviderClient: {
      async getRuntimeSettings() { return { targetLanguage: "vi", sourceLanguage: "en", multiVoice, speakerChunkSize: 2 }; },
      async translateBatch({ lines }) { return lines; },
      async labelSpeakers({ lines }) {
        speakerRequests.push(lines.map((line) => line.id));
        return lines.map(() => "S1");
      },
      async synthesize({ speaker }) {
        synthesisSpeakers.push(speaker);
        return { audio: new ArrayBuffer(8) };
      }
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
  video.currentTime = 0.4;
  const transcript = (await send("CONTENT_GET_TRANSCRIPT")).transcript;
  assert.equal(transcript.windowStart, 0);
  assert.equal(transcript.windowEnd, 0.4);
  assert.equal(transcript.rows.length, 1);
  assert.equal(transcript.rows[0].originals[0].text, "Hello.");
  assert.equal(transcript.rows[0].processed, "Hello.");
  video.currentTime = 40.2;
  const laterTranscript = (await send("CONTENT_GET_TRANSCRIPT")).transcript;
  assert.equal(laterTranscript.rows.length, 2);
  assert.equal(laterTranscript.rows[1].originals[0].start, 40);
  assert.equal(laterTranscript.rows[1].processed, "Later.");
  assert.equal(laterTranscript.rows[1].translation, null);
  assert.deepEqual(Array.from(laterTranscript.rows[1].audio), []);
  await new Promise((resolve) => messageHandler({ type: "CONTENT_SET_ORIGINAL_VOLUME", volume: 35 }, {}, resolve));
  assert.equal(video.volume, 0.35);
  assert.equal((await send("CONTENT_STOP")).ok, true);
  assert.equal(video.volume, 1);
  assert.equal(speakerRequests.length, 0);
  multiVoice = true;
  assert.equal((await send("CONTENT_START")).ok, true);
  assert.equal(fetchCount, 1);
  assert.equal(JSON.stringify(speakerRequests), "[[3]]");
  assert.equal(synthesisSpeakers.at(-1), "S1");
  video.currentTime = 40.4;
  const restartedTranscript = (await send("CONTENT_GET_TRANSCRIPT")).transcript;
  assert.equal(restartedTranscript.windowStart, 40.2);
  assert.equal(restartedTranscript.rows.length, 1);
  assert.equal(restartedTranscript.rows[0].originals[0].text, "Later.");
  await send("CONTENT_STOP");
});
