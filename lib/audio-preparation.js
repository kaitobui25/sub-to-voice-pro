(function initAudioPreparation(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SubToVoiceAudioPreparation = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function audioPreparationFactory() {
  "use strict";

  const DEFAULT_CONFIG = Object.freeze({
    adaptiveStartup: false, groupedResume: false,
    startupSeconds: 8, resumeSeconds: 8, maxBufferSeconds: 30,
    planningSeconds: 60, smoothing: 0.25
  });

  function normalizeConfig(input = {}) {
    const config = { ...DEFAULT_CONFIG };
    for (const key of ["adaptiveStartup", "groupedResume"]) config[key] = input[key] === true;
    for (const key of ["startupSeconds", "resumeSeconds", "maxBufferSeconds", "planningSeconds"]) {
      const value = Number(input[key]);
      if (Number.isFinite(value) && value > 0) config[key] = value;
    }
    const smoothing = Number(input.smoothing);
    if (smoothing > 0 && smoothing <= 1) config.smoothing = smoothing;
    config.maxBufferSeconds = Math.max(config.maxBufferSeconds, config.startupSeconds, config.resumeSeconds);
    return config;
  }

  function observe(previous, renderSeconds, videoSeconds, config) {
    if (!(renderSeconds > 0 && videoSeconds > 0)) return previous;
    const ratio = renderSeconds / videoSeconds;
    return previous == null ? ratio : previous * (1 - config.smoothing) + ratio * config.smoothing;
  }

  function targetSeconds(config, ratio, rate, phase) {
    const base = phase === "startup" ? config.startupSeconds : config.resumeSeconds;
    const deficit = Math.max(0, (ratio ?? 1) * rate - 1);
    return Math.min(config.maxBufferSeconds, base + deficit * config.planningSeconds);
  }

  // Only contiguous readiness counts. A ready cue beyond a gap cannot unblock playback.
  function readiness(sentences, start, videoTime, target, played = new Set()) {
    let end = start;
    let coverageEnd = videoTime;
    while (end < sentences.length) {
      const sentence = sentences[end];
      if (!sentence._buffer && !played.has(end)) {
        // Silence before the next missing cue is safe to play.
        coverageEnd = Math.max(coverageEnd, sentence.start);
        break;
      }
      coverageEnd = Math.max(coverageEnd, sentence.end);
      end += 1;
      if (coverageEnd - videoTime >= target) break;
    }
    const readySeconds = Math.max(0, coverageEnd - videoTime);
    return { end, readySeconds, targetSeconds: target,
      ready: (end > start || start >= sentences.length) &&
        (readySeconds >= target || end === sentences.length) };
  }

  return { DEFAULT_CONFIG, normalizeConfig, observe, targetSeconds, readiness };
});
