"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPlaybackClock, normalizeConfig } = require("../lib/playback-clock.js");
const {
  scheduleWindow,
  resyncPendingSources,
  cancelPendingSources,
  findScheduleWindow
} = require("../lib/audio-scheduler.js");

function fakeAudioContext(currentTime) {
  const created = [];
  return {
    currentTime,
    created,
    createBufferSource() {
      const playbackRate = {
        value: 1,
        setValueAtTime(value) { this.value = value; }
      };
      const source = {
        buffer: null,
        playbackRate,
        connectedTo: null,
        startAt: null,
        stopped: false,
        disconnected: false,
        onended: null,
        connect(node) { this.connectedTo = node; },
        start(at) { this.startAt = at; },
        stop() { this.stopped = true; },
        disconnect() { this.disconnected = true; }
      };
      created.push(source);
      return source;
    }
  };
}

function makeSession({ audioTime, videoTime, rate = 1, sentences, scheduledAudioEndAt = 0 }) {
  return {
    audioCtx: fakeAudioContext(audioTime),
    outputGain: {},
    playbackClock: createPlaybackClock({ videoTime, audioTime, rate }),
    playbackSync: normalizeConfig(),
    sentences,
    scheduledAudioEndAt,
    pendingSources: []
  };
}

test("scheduler preserves the existing 1x timestamp mapping", () => {
  const session = makeSession({
    audioTime: 12.5,
    videoTime: 10,
    sentences: [{ start: 14, end: 15, _buffer: { duration: 1 } }]
  });
  const [item] = scheduleWindow(session, 0, 1, { startEpsilonSec: 0 });
  assert.equal(item.playAt, 16.5);
  assert.equal(item.videoStart, 14);
  assert.equal(item.voiceRate, 1);
});

test("scheduler maps future cues to 2x and scales decoded audio duration", () => {
  const session = makeSession({
    audioTime: 50,
    videoTime: 100,
    rate: 2,
    sentences: [{ start: 110, end: 114, _buffer: { duration: 4 } }]
  });
  const [item] = scheduleWindow(session, 0, 1, { startEpsilonSec: 0 });
  assert.equal(item.playAt, 55);
  assert.equal(item.source.playbackRate.value, 2);
  assert.equal(item.wallDuration, 2);
  assert.equal(item.videoDuration, 4);
  assert.equal(session.scheduledAudioEndAt, 57);
});

test("scheduler maps future cues to 0.5x", () => {
  const session = makeSession({
    audioTime: 50,
    videoTime: 100,
    rate: 0.5,
    sentences: [{ start: 110, end: 114, _buffer: { duration: 4 } }]
  });
  const [item] = scheduleWindow(session, 0, 1, { startEpsilonSec: 0 });
  assert.equal(item.playAt, 70);
  assert.equal(item.source.playbackRate.value, 0.5);
  assert.equal(item.wallDuration, 8);
  assert.equal(item.videoDuration, 4);
});

test("scheduler late decisions use actual video time at the current rate", () => {
  const session = makeSession({
    audioTime: 20,
    videoTime: 15,
    rate: 2,
    sentences: [
      { start: 10, end: 11, _buffer: { duration: 1 } },
      { start: 15.2, end: 16, _buffer: { duration: 1 } }
    ]
  });
  const decisions = [];
  const scheduled = scheduleWindow(session, 0, 2, {
    lateThresholdSec: 0.5,
    startEpsilonSec: 0,
    onDecision: (decision) => decisions.push(decision)
  });
  assert.deepEqual(scheduled.map((item) => item.index), [1]);
  assert.deepEqual(decisions.map(({ status }) => status), ["late", "scheduled"]);
  assert.equal(decisions[0].lateBy, 5);
  assert.equal(decisions[0].videoRate, 2);
});

test("scheduleWindow does not schedule one sentence twice", () => {
  const session = makeSession({
    audioTime: 5,
    videoTime: 5,
    sentences: [{ start: 6, end: 7, _buffer: { duration: 1 } }]
  });
  assert.equal(scheduleWindow(session, 0, 1).length, 1);
  assert.equal(scheduleWindow(session, 0, 1).length, 0);
  assert.equal(session.audioCtx.created.length, 1);
});

test("a naturally completed cue is not scheduled again until playback history is reset", () => {
  const session = makeSession({
    audioTime: 5,
    videoTime: 5,
    sentences: [{ start: 6, end: 7, _buffer: { duration: 1 } }]
  });
  const [first] = scheduleWindow(session, 0, 1);
  first.source.onended();
  assert.equal(session.playedSentenceIndexes.has(0), true);
  assert.equal(scheduleWindow(session, 0, 1).length, 0);
  session.playedSentenceIndexes.clear();
  assert.equal(scheduleWindow(session, 0, 1).length, 1);
});

test("cancelling a pending cue does not mark it as played", () => {
  const session = makeSession({
    audioTime: 5,
    videoTime: 5,
    sentences: [{ start: 6, end: 7, _buffer: { duration: 1 } }]
  });
  const [first] = scheduleWindow(session, 0, 1);
  cancelPendingSources(session);
  first.source.onended();
  assert.equal(session.playedSentenceIndexes.has(0), false);
  assert.equal(scheduleWindow(session, 0, 1).length, 1);
});

test("adjacent TTS audio serializes using rate-scaled wall duration", () => {
  const session = makeSession({
    audioTime: 100,
    videoTime: 100,
    rate: 2,
    sentences: [
      { start: 100, end: 107.6, _buffer: { duration: 7.76 } },
      { start: 107.6, end: 112.69, _buffer: { duration: 5.84 } }
    ]
  });
  const [first] = scheduleWindow(session, 0, 1);
  const [second] = scheduleWindow(session, 1, 2);
  assert.equal(first.voiceRate, 2);
  assert.equal(first.wallDuration, 3.88);
  assert.equal(second.playAt, first.playAt + first.wallDuration);
});

test("rate resync keeps the active source, updates its rate, and cancels future sources", () => {
  const session = makeSession({
    audioTime: 10,
    videoTime: 10,
    rate: 1,
    sentences: [
      { start: 10, end: 14, _buffer: { duration: 4 } },
      { start: 12, end: 14, _buffer: { duration: 2 } }
    ]
  });
  const [active, future] = scheduleWindow(session, 0, 2, { startEpsilonSec: 0 });
  assert.equal(active.playAt, 10);
  assert.equal(future.playAt, 14);

  session.audioCtx.currentTime = 11;
  session.playbackClock.refresh({ videoTime: 11, audioTime: 11, rate: 2 });
  const result = resyncPendingSources(session);

  assert.equal(result.activeSource, active.source);
  assert.deepEqual(result.cancelledSources, [future.source]);
  assert.equal(active.source.playbackRate.value, 2);
  assert.equal(active.source.stopped, false);
  assert.equal(future.source.stopped, true);
  assert.equal(session.scheduledSentenceIndexes.has(0), true);
  assert.equal(session.scheduledSentenceIndexes.has(1), false);
  assert.equal(session.scheduledAudioEndAt, 12.5);

  session.audioCtx.currentTime = 12;
  session.playbackClock.refresh({ videoTime: 13, audioTime: 12, rate: 0.5 });
  const second = resyncPendingSources(session);
  assert.equal(second.activeSource, active.source);
  assert.equal(active.source.playbackRate.value, 0.5);
  assert.equal(active.source._decodedDuration, 1);
  assert.equal(session.scheduledAudioEndAt, 14);
});

test("cancelPendingSources stops, disconnects and clears scheduling state", () => {
  const session = makeSession({
    audioTime: 1,
    videoTime: 1,
    sentences: [{ start: 2, end: 3, _buffer: { duration: 1 } }]
  });
  scheduleWindow(session, 0, 1);
  const source = session.pendingSources[0];
  cancelPendingSources(session);
  assert.equal(source.stopped, true);
  assert.equal(source.disconnected, true);
  assert.equal(session.pendingSources.length, 0);
  assert.equal(session.scheduledSentenceIndexes.size, 0);
  assert.equal(session.scheduledAudioEndAt, 0);
});

test("findScheduleWindow returns current cue through configured lookahead", () => {
  const sentences = [
    { start: 0, end: 2 },
    { start: 8, end: 10 },
    { start: 38, end: 40 },
    { start: 41, end: 43 }
  ];
  assert.deepEqual(findScheduleWindow(sentences, 9, 30000), { start: 1, end: 3 });
});
