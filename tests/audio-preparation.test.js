"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const preparation = require("../lib/audio-preparation.js");
const config = preparation.normalizeConfig({ adaptiveStartup: true, groupedResume: true });
const cue = (start, end, ready = true) => ({ start, end, _buffer: ready ? {} : null });

test("adaptive buffer grows with measured render deficit and playback rate, within the cap", () => {
  assert.equal(preparation.targetSeconds(config, 0.8, 1, "startup"), 6);
  assert.ok(preparation.targetSeconds(config, 1.2, 1, "startup") > 6);
  assert.equal(preparation.targetSeconds(config, 1.2, 2, "startup"), 8);
  const estimate = preparation.observe(null, 6, 3, config);
  assert.equal(estimate.ratio, null);
  assert.equal(preparation.observe(estimate, 6, 5, config).ratio, 1.5);
});

test("resume requires contiguous audio and ignores ready cues beyond a gap", () => {
  const sentences = [cue(0, 3), cue(3, 5, false), cue(5, 10)];
  assert.equal(preparation.readiness(sentences, 0, 0, 8).ready, false);
  sentences[1]._buffer = {};
  assert.equal(preparation.readiness(sentences, 0, 0, 8).ready, true);
});

test("short final segment resumes without waiting for a full target", () => {
  assert.equal(preparation.readiness([cue(0, 2)], 0, 0, 30).ready, true);
  assert.equal(preparation.readiness([cue(0, 2, false)], 0, 0, 30).ready, false);
  assert.equal(preparation.readiness([], 0, 0, 30).ready, true);
});

test("silence extends safe coverage; missing current cue still blocks resume", () => {
  assert.equal(preparation.readiness([cue(0, 2), cue(12, 14, false)], 0, 0, 8).ready, true);
  assert.equal(preparation.readiness([cue(0, 2, false), cue(12, 14)], 0, 1, 8).ready, false);
});

test("invalid config falls back and the cap cannot be smaller than the base buffer", () => {
  const normalized = preparation.normalizeConfig({ startupSeconds: -1, resumeSeconds: 10, maxBufferSeconds: 2 });
  assert.equal(normalized.startupSeconds, 6);
  assert.equal(normalized.maxBufferSeconds, 10);
});

test("a very short cue contributes its actual duration instead of dominating the estimate", () => {
  let estimate = preparation.observe(null, 10, 10, config);
  estimate = preparation.observe(estimate, 0.97, 0.12, config);
  assert.ok(estimate.ratio < 1.1);
  assert.equal(preparation.targetSeconds(config, estimate.ratio, 1, "resume") < 4, true);
  for (let index = 0; index < 20; index += 1) estimate = preparation.observe(estimate, 3, 3, config);
  assert.equal(estimate.samples.length, config.estimationWindow);
  assert.equal(estimate.ratio, 1);
});
