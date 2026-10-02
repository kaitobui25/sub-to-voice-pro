"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_CONFIG,
  normalizeConfig,
  normalizeRate,
  createPlaybackClock
} = require("../lib/playback-clock.js");

test("playback clock maps video time to audio time at 1x", () => {
  const clock = createPlaybackClock({ videoTime: 100, audioTime: 50, rate: 1 });
  assert.equal(clock.videoToAudioTime(110), 60);
  assert.equal(clock.audioToVideoTime(60), 110);
});

test("playback clock maps 2x and 0.5x using anchor slope", () => {
  const fast = createPlaybackClock({ videoTime: 100, audioTime: 50, rate: 2 });
  assert.equal(fast.videoToAudioTime(110), 55);
  assert.equal(fast.audioToVideoTime(55), 110);

  const slow = createPlaybackClock({ videoTime: 100, audioTime: 50, rate: 0.5 });
  assert.equal(slow.videoToAudioTime(110), 70);
  assert.equal(slow.audioToVideoTime(70), 110);
});

test("refresh replaces the anchor without accumulating prior drift", () => {
  const clock = createPlaybackClock({ videoTime: 0, audioTime: 0, rate: 1 });
  clock.refresh({ videoTime: 40, audioTime: 12, rate: 1.5 });
  assert.deepEqual(clock.snapshot(), { videoTime: 40, audioTime: 12, rate: 1.5 });
  assert.equal(clock.videoToAudioTime(46), 16);
});

test("playback config normalizes timing knobs without changing observed video rates", () => {
  const config = normalizeConfig({ lookaheadMs: 15000, lateThresholdMs: 250, startEpsilonMs: 10 });
  assert.equal(config.lookaheadMs, 15000);
  assert.equal(config.lateThresholdMs, 250);
  assert.equal(config.startEpsilonMs, 10);
  assert.equal(normalizeRate(3), 3);
  assert.equal(normalizeRate(0.25), 0.25);
  assert.equal(normalizeConfig({}).lookaheadMs, DEFAULT_CONFIG.lookaheadMs);
});

test("playback clock rejects invalid anchor rates", () => {
  const clock = createPlaybackClock();
  assert.throws(
    () => clock.refresh({ videoTime: 0, audioTime: 0, rate: 0 }),
    /Playback rate must be a positive finite number/
  );
});
