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

  const scheduled = scheduleWindow(session, 0, 2);
  assert.deepEqual(scheduled.map((item) => item.index), [1]);
  assert.equal(audioCtx.created.length, 1);
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
