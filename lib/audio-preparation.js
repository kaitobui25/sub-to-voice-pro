(function initAudioPreparation(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SubToVoiceAudioPreparation = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function audioPreparationFactory() {
  "use strict";

  const DEFAULT_CONFIG = Object.freeze({
    adaptiveStartup: false, groupedResume: false,
    startupSeconds: 6, resumeSeconds: 3, maxBufferSeconds: 8,
    planningSeconds: 10, startupMaxWaitSeconds: 8, resumeMaxWaitSeconds: 5,
    estimationWindow: 12, estimationMinVideoSeconds: 8
  });

  function normalizeConfig(input = {}) {
    const config = { ...DEFAULT_CONFIG };
    for (const key of ["adaptiveStartup", "groupedResume"]) config[key] = input[key] === true;
    for (const key of ["startupSeconds", "resumeSeconds", "maxBufferSeconds", "planningSeconds",
      "startupMaxWaitSeconds", "resumeMaxWaitSeconds", "estimationMinVideoSeconds"]) {
      const value = Number(input[key]);
      if (Number.isFinite(value) && value > 0) config[key] = value;
    }
    if (Number.isFinite(Number(input.estimationWindow)) && Number(input.estimationWindow) >= 1) {
      config.estimationWindow = Math.floor(Number(input.estimationWindow));
    }
    config.maxBufferSeconds = Math.max(config.maxBufferSeconds, config.startupSeconds, config.resumeSeconds);
    return config;
  }

  function observe(previous, renderSeconds, videoSeconds, config) {
    if (!(Number.isFinite(renderSeconds) && Number.isFinite(videoSeconds) && renderSeconds > 0 && videoSeconds > 0)) return previous;
    const samples = [...(previous?.samples || []), { renderSeconds, videoSeconds }].slice(-config.estimationWindow);
    const totals = samples.reduce((sum, sample) => ({
      renderSeconds: sum.renderSeconds + sample.renderSeconds,
      videoSeconds: sum.videoSeconds + sample.videoSeconds
    }), { renderSeconds: 0, videoSeconds: 0 });
    return { samples, ...totals,
      ratio: totals.videoSeconds >= config.estimationMinVideoSeconds ? totals.renderSeconds / totals.videoSeconds : null };
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
