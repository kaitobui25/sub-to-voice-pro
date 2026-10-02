(function initPlaybackClock(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SubToVoicePlaybackClock = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function playbackClockFactory() {
  "use strict";

  const DEFAULT_CONFIG = Object.freeze({
    lookaheadMs: 30000,
    lateThresholdMs: 500,
    startEpsilonMs: 20
  });

  function finiteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function normalizeConfig(config) {
    const input = config || {};
    return {
      lookaheadMs: Math.max(0, finiteNumber(input.lookaheadMs, DEFAULT_CONFIG.lookaheadMs)),
      lateThresholdMs: Math.max(0, finiteNumber(input.lateThresholdMs, DEFAULT_CONFIG.lateThresholdMs)),
      startEpsilonMs: Math.max(0, finiteNumber(input.startEpsilonMs, DEFAULT_CONFIG.startEpsilonMs))
    };
  }

  function normalizeRate(rate) {
    const value = finiteNumber(rate, 1);
    if (!(value > 0)) return 1;
    return value;
  }

  function createPlaybackClock(initial) {
    let anchor = { videoTime: 0, audioTime: 0, rate: 1 };

    function refresh(next) {
      const value = next || {};
      const videoTime = finiteNumber(value.videoTime, anchor.videoTime);
      const audioTime = finiteNumber(value.audioTime, anchor.audioTime);
      const rate = Number(value.rate);
      if (!(Number.isFinite(rate) && rate > 0)) {
        throw new TypeError("Playback rate must be a positive finite number.");
      }
      anchor = { videoTime, audioTime, rate };
      return snapshot();
    }

    function videoToAudioTime(videoTime) {
      const target = finiteNumber(videoTime, anchor.videoTime);
      return anchor.audioTime + (target - anchor.videoTime) / anchor.rate;
    }

    function audioToVideoTime(audioTime) {
      const target = finiteNumber(audioTime, anchor.audioTime);
      return anchor.videoTime + (target - anchor.audioTime) * anchor.rate;
    }

    function snapshot() {
      return { ...anchor };
    }

    refresh({
      videoTime: finiteNumber(initial?.videoTime, 0),
      audioTime: finiteNumber(initial?.audioTime, 0),
      rate: Number.isFinite(Number(initial?.rate)) && Number(initial?.rate) > 0
        ? Number(initial.rate) : 1
    });

    return { refresh, videoToAudioTime, audioToVideoTime, snapshot };
  }

  return { DEFAULT_CONFIG, normalizeConfig, normalizeRate, createPlaybackClock };
});
