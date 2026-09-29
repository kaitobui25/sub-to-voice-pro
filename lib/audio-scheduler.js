(function initAudioScheduler(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SubToVoiceAudioScheduler = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function audioSchedulerFactory() {
  "use strict";

  const LOOKAHEAD_MS = 30000;
  const LATE_CUE_THRESHOLD_SEC = 0.5;
  const START_EPSILON_SEC = 0.02;

  function computeAudioOffset(audioContextTime, videoTime) {
    return Number(audioContextTime) - Number(videoTime);
  }

  function computePlayAt(audioOffset, sentenceStart) {
    return Number(audioOffset) + Number(sentenceStart);
  }

  async function decodeCompleteAudio(audioContext, audioBytes) {
    if (!audioContext || typeof audioContext.decodeAudioData !== "function") {
      throw new Error("AudioContext unavailable.");
    }
    if (!(audioBytes instanceof ArrayBuffer)) {
      throw new TypeError("TTS audio must be an ArrayBuffer.");
    }
    return audioContext.decodeAudioData(audioBytes);
  }

  function ensureScheduleState(session) {
    if (!Array.isArray(session.pendingSources)) session.pendingSources = [];
    if (!(session.scheduledSentenceIndexes instanceof Set)) {
      session.scheduledSentenceIndexes = new Set();
    }
  }

  function scheduleWindow(session, startIdx, endIdx, options) {
    if (!session || !session.audioCtx || !session.outputGain) return [];
    ensureScheduleState(session);

    const opts = options || {};
    const lateThreshold = opts.lateThresholdSec == null
      ? LATE_CUE_THRESHOLD_SEC
      : opts.lateThresholdSec;
    const startEpsilon = opts.startEpsilonSec == null
      ? START_EPSILON_SEC
      : opts.startEpsilonSec;
    const now = session.audioCtx.currentTime;
    const scheduled = [];

    for (let index = startIdx; index < endIdx; index += 1) {
      const sentence = session.sentences?.[index];
      const buffer = sentence?._buffer;
      if (!buffer || session.scheduledSentenceIndexes.has(index)) continue;

      const at = computePlayAt(session.audioOffset, sentence.start);
      if (at < now - lateThreshold) continue;

      const source = session.audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(session.outputGain);
      source._sentenceIdx = index;

      const actualPlayAt = Math.max(at, now + startEpsilon, session.scheduledAudioEndAt || 0);
      try {
        source.start(actualPlayAt);
      } catch {
        try { source.disconnect(); } catch {}
        continue;
      }

      const duration = Number.isFinite(buffer.duration) ? Math.max(0, buffer.duration) : 0;
      session.scheduledAudioEndAt = actualPlayAt + duration;

      session.scheduledSentenceIndexes.add(index);
      session.pendingSources.push(source);
      scheduled.push({ index, source, playAt: actualPlayAt, duration });

      source.onended = () => {
        session.onAudioEnded?.(source);
        session.pendingSources = session.pendingSources.filter((item) => item !== source);
        session.scheduledSentenceIndexes.delete(index);
        try { source.disconnect(); } catch {}
      };
    }

    return scheduled;
  }

  function cancelPendingSources(session) {
    if (!session) return;
    ensureScheduleState(session);
    for (const source of session.pendingSources) {
      try { source.stop(); } catch {}
      try { source.disconnect(); } catch {}
    }
    session.pendingSources = [];
    session.scheduledSentenceIndexes.clear();
    session.scheduledAudioEndAt = 0;
  }

  function findScheduleWindow(sentences, playheadSec, lookaheadMs) {
    const items = Array.isArray(sentences) ? sentences : [];
    const lookaheadSec = (lookaheadMs == null ? LOOKAHEAD_MS : lookaheadMs) / 1000;
    let start = items.findIndex((sentence) => sentence.end >= playheadSec);
    if (start === -1) return { start: items.length, end: items.length };

    let end = items.findIndex((sentence) => sentence.start > playheadSec + lookaheadSec);
    if (end === -1) end = items.length;
    return { start, end };
  }

  function scheduleAroundPlayhead(session, video, options) {
    if (!session || !video) return { start: 0, end: 0, scheduled: [] };
    const window = findScheduleWindow(
      session.sentences,
      video.currentTime,
      options?.lookaheadMs
    );
    const scheduled = scheduleWindow(session, window.start, window.end, options);
    return { ...window, scheduled };
  }

  return {
    LOOKAHEAD_MS,
    LATE_CUE_THRESHOLD_SEC,
    START_EPSILON_SEC,
    computeAudioOffset,
    computePlayAt,
    decodeCompleteAudio,
    scheduleWindow,
    cancelPendingSources,
    findScheduleWindow,
    scheduleAroundPlayhead
  };
});
