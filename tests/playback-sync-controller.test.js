"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPlaybackClock } = require("../lib/playback-clock.js");
const { createPlaybackSyncController } = require("../lib/playback-sync-controller.js");

function fakeVideo() {
  const listeners = new Map();
  return {
    currentTime: 10,
    playbackRate: 1,
    listeners,
    addEventListener(name, handler) { listeners.set(name, handler); },
    removeEventListener(name, handler) {
      if (listeners.get(name) === handler) listeners.delete(name);
    }
  };
}

test("playback sync controller owns lifecycle listeners and refreshes the shared clock", () => {
  const video = fakeVideo();
  const audioCtx = { currentTime: 5 };
  const clock = createPlaybackClock();
  let rateChanges = 0;
  const controller = createPlaybackSyncController({
    video,
    audioCtx,
    clock,
    resolveRate: (rate) => rate,
    onRateChange() { rateChanges += 1; }
  });

  controller.attach();
  assert.deepEqual([...video.listeners.keys()].sort(), ["ended", "pause", "play", "ratechange", "seeked"]);

  video.currentTime = 20;
  video.playbackRate = 2;
  audioCtx.currentTime = 8;
  assert.deepEqual(controller.refreshAnchor(), { videoTime: 20, audioTime: 8, rate: 2 });
  video.listeners.get("ratechange")();
  assert.equal(rateChanges, 1);

  controller.detach();
  assert.equal(video.listeners.size, 0);
});

test("attach and detach are idempotent", () => {
  const video = fakeVideo();
  const controller = createPlaybackSyncController({
    video,
    audioCtx: { currentTime: 0 },
    clock: createPlaybackClock()
  });
  controller.attach();
  controller.attach();
  assert.equal(video.listeners.size, 5);
  controller.detach();
  controller.detach();
  assert.equal(video.listeners.size, 0);
});
