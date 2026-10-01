"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  computeAudioOffset,
  computePlayAt,
  scheduleWindow,
  cancelPendingSources,
  findScheduleWindow
} = require("../lib/audio-scheduler.js");

function fakeAudioContext(currentTime) {
  const created = [];
  return {
    currentTime,
    created,
    createBufferSource() {
      const source = {
        buffer: null,
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

test("audio offset and playAt match Echoly timestamp math", () => {
  const offset = computeAudioOffset(12.5, 10);
  assert.equal(offset, 2.5);
  assert.equal(computePlayAt(offset, 14), 16.5);
});

test("scheduleWindow skips materially late cues", () => {
  const audioCtx = fakeAudioContext(20);
  const session = {
    audioCtx,
    outputGain: {},
    audioOffset: 5,
    sentences: [
      { start: 10, end: 11, _buffer: { id: "late" } },
      { start: 15.2, end: 16, _buffer: { id: "ready" } }
    ],
    pendingSources: []
  };

  const decisions = [];
  const scheduled = scheduleWindow(session, 0, 2, {
    onDecision: (decision) => decisions.push(decision)
  });
  assert.deepEqual(scheduled.map((item) => item.index), [1]);
  assert.equal(audioCtx.created.length, 1);
  assert.deepEqual(decisions.map(({ status }) => status), ["late", "scheduled"]);
  assert.equal(decisions[0].lateBy, 5);
  assert.equal(decisions[0].limit, 0.5);
});

test("scheduleWindow does not schedule one sentence twice", () => {
  const audioCtx = fakeAudioContext(5);
  const session = {
    audioCtx,
    outputGain: {},
    audioOffset: 0,
    sentences: [{ start: 6, end: 7, _buffer: { id: "one" } }],
    pendingSources: []
  };

  assert.equal(scheduleWindow(session, 0, 1).length, 1);
  assert.equal(scheduleWindow(session, 0, 1).length, 0);
  assert.equal(audioCtx.created.length, 1);
});

test("a naturally completed cue is not scheduled again until playback history is reset", () => {
  const audioCtx = fakeAudioContext(5);
  const session = {
    audioCtx,
    outputGain: {},
    audioOffset: 0,
    sentences: [{ start: 6, end: 7, _buffer: { duration: 1 } }],
    pendingSources: []
  };
  const [first] = scheduleWindow(session, 0, 1);
  first.source.onended();
  assert.equal(session.playedSentenceIndexes.has(0), true);
  assert.equal(scheduleWindow(session, 0, 1).length, 0);
  session.playedSentenceIndexes.clear();
  assert.equal(scheduleWindow(session, 0, 1).length, 1);
});

test("cancelling a pending cue does not mark it as played", () => {
  const audioCtx = fakeAudioContext(5);
  const session = {
    audioCtx,
    outputGain: {},
    audioOffset: 0,
    sentences: [{ start: 6, end: 7, _buffer: { duration: 1 } }],
    pendingSources: []
  };
  const [first] = scheduleWindow(session, 0, 1);
  cancelPendingSources(session);
  first.source.onended();
  assert.equal(session.playedSentenceIndexes.has(0), false);
  assert.equal(scheduleWindow(session, 0, 1).length, 1);
});

test("scheduleWindow exposes the actual audio start and decoded duration", () => {
  const audioCtx = fakeAudioContext(5);
  const session = {
    audioCtx, outputGain: {}, audioOffset: 0,
    sentences: [{ start: 5, end: 6, _buffer: { duration: 1.25 } }],
    pendingSources: []
  };
  const [item] = scheduleWindow(session, 0, 1);
  assert.equal(item.playAt, 5.02);
  assert.equal(item.duration, 1.25);
  assert.equal(item.source.startAt, item.playAt);
});

test("adjacent TTS audio waits for the previous audio across scheduling windows", () => {
  const audioCtx = fakeAudioContext(100);
  const session = {
    audioCtx, outputGain: {}, audioOffset: 0,
    sentences: [
      { start: 100, end: 107.6, _buffer: { duration: 7.76 } },
      { start: 107.6, end: 112.69, _buffer: { duration: 5.84 } },
      { start: 112.69, end: 115, _buffer: { duration: 2.08 } }
    ], pendingSources: []
  };
  const [first] = scheduleWindow(session, 0, 1);
  const [second] = scheduleWindow(session, 1, 2);
  const [third] = scheduleWindow(session, 2, 3);
  assert.equal(first.playAt, 100.02);
  assert.equal(second.playAt, first.playAt + first.duration);
  assert.equal(third.playAt, second.playAt + second.duration);
});

test("a cue late by wall clock still appends while dubbed audio is already queued", () => {
  const audioCtx = fakeAudioContext(20);
  const session = {
    audioCtx, outputGain: {}, audioOffset: 5,
    scheduledAudioEndAt: 24,
    sentences: [{ start: 10, end: 11, _buffer: { duration: 2 } }],
    pendingSources: []
  };
  const decisions = [];
  const [item] = scheduleWindow(session, 0, 1, {
    onDecision: (decision) => decisions.push(decision)
  });
  assert.equal(item.playAt, 24);
  assert.equal(decisions[0].status, "scheduled");
});

test("cancelling scheduled audio clears the wait before scheduling after a seek", () => {
  const audioCtx = fakeAudioContext(10);
  const session = {
    audioCtx, outputGain: {}, audioOffset: 0,
    sentences: [
      { start: 11, end: 12, _buffer: { duration: 8 } },
      { start: 12, end: 13, _buffer: { duration: 1 } }
    ], pendingSources: []
  };
  scheduleWindow(session, 0, 1);
  cancelPendingSources(session);
  audioCtx.currentTime = 12;
  const [next] = scheduleWindow(session, 1, 2);
  assert.equal(next.playAt, 12.02);
});

test("cancelPendingSources stops, disconnects and clears scheduling state", () => {
  const audioCtx = fakeAudioContext(1);
  const session = {
    audioCtx,
    outputGain: {},
    audioOffset: 0,
    sentences: [{ start: 2, end: 3, _buffer: { id: "one" } }],
    pendingSources: []
  };
  scheduleWindow(session, 0, 1);
  const source = session.pendingSources[0];
  cancelPendingSources(session);
  assert.equal(source.stopped, true);
  assert.equal(source.disconnected, true);
  assert.equal(session.pendingSources.length, 0);
  assert.equal(session.scheduledSentenceIndexes.size, 0);
});

test("findScheduleWindow returns current cue through 30 second lookahead", () => {
  const sentences = [
    { start: 0, end: 2 },
    { start: 8, end: 10 },
    { start: 38, end: 40 },
    { start: 41, end: 43 }
  ];
  assert.deepEqual(findScheduleWindow(sentences, 9, 30000), { start: 1, end: 3 });
});
