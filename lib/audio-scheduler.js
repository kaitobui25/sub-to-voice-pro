(function initAudioScheduler(root, factory) {
  const playbackClockApi = root.SubToVoicePlaybackClock ||
    (typeof module !== "undefined" && module.exports ? require("./playback-clock.js") : null);
  const api = factory(playbackClockApi);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SubToVoiceAudioScheduler = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function audioSchedulerFactory(PlaybackClock) {
  "use strict";

  if (!PlaybackClock) throw new Error("Playback clock module did not load.");

  function playbackConfig(session) {
    return PlaybackClock.normalizeConfig(session?.playbackSync || session?.settings?.playbackSync);
  }

  function playbackClock(session) {
    const clock = session?.playbackClock;
    if (!clock || typeof clock.videoToAudioTime !== "function" ||
        typeof clock.audioToVideoTime !== "function" || typeof clock.snapshot !== "function") {
      throw new Error("Audio scheduler requires a playback clock.");
    }
    return clock;
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
    if (!(session.playedSentenceIndexes instanceof Set)) {
      session.playedSentenceIndexes = new Set();
    }
  }

  function setSourceRate(source, rate, at) {
    if (!source?.playbackRate) return;
    if (typeof source.playbackRate.setValueAtTime === "function") {
      source.playbackRate.setValueAtTime(rate, Math.max(0, Number(at) || 0));
    } else {
      source.playbackRate.value = rate;
    }
  }

  function scheduleWindow(session, startIdx, endIdx, options) {
    if (!session || !session.audioCtx || !session.outputGain) return [];
    ensureScheduleState(session);

    const opts = options || {};
    const config = playbackConfig(session);
    const clock = playbackClock(session);
    const snapshot = clock.snapshot();
    const clockRate = snapshot.rate;
    const voiceRate = clockRate;
    const lateThresholdSec = opts.lateThresholdSec == null
      ? config.lateThresholdMs / 1000
      : Math.max(0, Number(opts.lateThresholdSec));
    const startEpsilonSec = opts.startEpsilonSec == null
      ? config.startEpsilonMs / 1000
      : Math.max(0, Number(opts.startEpsilonSec));
    const now = session.audioCtx.currentTime;
    const currentVideoTime = clock.audioToVideoTime(now);
    const scheduled = [];

    for (let index = startIdx; index < endIdx; index += 1) {
      const sentence = session.sentences?.[index];
      const buffer = sentence?._buffer;
      if (!buffer || session.scheduledSentenceIndexes.has(index) ||
          session.playedSentenceIndexes.has(index)) continue;

      const plannedPlayAt = clock.videoToAudioTime(sentence.start);
      const lateByVideo = currentVideoTime - Number(sentence.start);
      const queuedUntil = Number(session.scheduledAudioEndAt || 0);
      const hasQueuedAudio = queuedUntil > now + startEpsilonSec;
      if (lateByVideo > lateThresholdSec && !hasQueuedAudio && opts.allowLate !== true) {
        opts.onDecision?.({
          index,
          status: "late",
          lateBy: lateByVideo,
          limit: lateThresholdSec,
          videoTime: currentVideoTime,
          videoRate: clockRate,
          plannedAudioTime: plannedPlayAt
        });
        continue;
      }

      const source = session.audioCtx.createBufferSource();
      source.buffer = buffer;
      setSourceRate(source, voiceRate, now);
      source.connect(session.outputGain);
      source._sentenceIdx = index;
      source._cancelledByScheduler = false;

      const actualPlayAt = Math.max(plannedPlayAt, now + startEpsilonSec, queuedUntil);
      try {
        source.start(actualPlayAt);
      } catch {
        opts.onDecision?.({
          index,
          status: "start_failed",
          videoTime: currentVideoTime,
          videoRate: clockRate,
          plannedAudioTime: plannedPlayAt
        });
        try { source.disconnect(); } catch {}
        continue;
      }

      const decodedDuration = Number.isFinite(buffer.duration) ? Math.max(0, buffer.duration) : 0;
      const wallDuration = voiceRate > 0 ? decodedDuration / voiceRate : decodedDuration;
      const videoDuration = wallDuration * clockRate;
      session.scheduledAudioEndAt = actualPlayAt + wallDuration;
      source._scheduledStartAt = actualPlayAt;
      source._scheduledEndAt = session.scheduledAudioEndAt;
      source._playbackRate = voiceRate;
      source._decodedDuration = decodedDuration;

      session.scheduledSentenceIndexes.add(index);
      session.pendingSources.push(source);
      const item = {
        index,
        source,
        playAt: actualPlayAt,
        plannedPlayAt,
        videoStart: clock.audioToVideoTime(actualPlayAt),
        decodedDuration,
        wallDuration,
        videoDuration,
        videoRate: clockRate,
        voiceRate
      };
      scheduled.push(item);
      opts.onDecision?.({
        index,
        status: "scheduled",
        videoTime: currentVideoTime,
        videoRate: clockRate,
        plannedAudioTime: plannedPlayAt,
        actualAudioTime: actualPlayAt,
        plannedVideoTime: sentence.start,
        actualVideoTime: item.videoStart,
        driftMs: (item.videoStart - sentence.start) * 1000
      });

      source.onended = () => {
        if (!source._cancelledByScheduler) session.playedSentenceIndexes.add(index);
        session.onAudioEnded?.(source);
        session.pendingSources = session.pendingSources.filter((item) => item !== source);
        session.scheduledSentenceIndexes.delete(index);
        try { source.disconnect(); } catch {}
      };
    }

    return scheduled;
  }

  function resyncPendingSources(session) {
    if (!session?.audioCtx) return { activeSource: null, cancelledSources: [] };
    ensureScheduleState(session);
    const clock = playbackClock(session);
    const now = session.audioCtx.currentTime;
    const nextVoiceRate = clock.snapshot().rate;
    const kept = [];
    const cancelledSources = [];
    let activeSource = null;

    for (const source of session.pendingSources) {
      const startAt = Number(source._scheduledStartAt);
      const endAt = Number(source._scheduledEndAt);
      const isActive = Number.isFinite(startAt) && Number.isFinite(endAt) &&
        startAt <= now && endAt > now && activeSource == null;
      if (isActive) {
        const priorRate = Number(source._playbackRate) > 0 ? Number(source._playbackRate) : 1;
        const duration = Math.max(0, Number(source._decodedDuration) || 0);
        const consumed = Math.min(duration, Math.max(0, now - startAt) * priorRate);
        const remaining = Math.max(0, duration - consumed);
        setSourceRate(source, nextVoiceRate, now);
        source._playbackRate = nextVoiceRate;
        source._scheduledStartAt = now;
        source._decodedDuration = remaining;
        source._scheduledEndAt = now + (nextVoiceRate > 0 ? remaining / nextVoiceRate : remaining);
        activeSource = source;
        kept.push(source);
        continue;
      }

      source._cancelledByScheduler = true;
      try { source.stop(); } catch {}
      try { source.disconnect(); } catch {}
      session.scheduledSentenceIndexes.delete(source._sentenceIdx);
      cancelledSources.push(source);
    }

    session.pendingSources = kept;
    session.scheduledAudioEndAt = activeSource ? activeSource._scheduledEndAt : 0;
    return { activeSource, cancelledSources };
  }

  function cancelPendingSources(session) {
    if (!session) return;
    ensureScheduleState(session);
    for (const source of session.pendingSources) {
      source._cancelledByScheduler = true;
      try { source.stop(); } catch {}
      try { source.disconnect(); } catch {}
    }
    session.pendingSources = [];
    session.scheduledSentenceIndexes.clear();
    session.scheduledAudioEndAt = 0;
  }

  function findScheduleWindow(sentences, playheadSec, lookaheadMs) {
    const items = Array.isArray(sentences) ? sentences : [];
    const lookaheadSec = Math.max(0, Number(lookaheadMs) || 0) / 1000;
    let start = items.findIndex((sentence) => sentence.end >= playheadSec);
    if (start === -1) return { start: items.length, end: items.length };

    let end = items.findIndex((sentence) => sentence.start > playheadSec + lookaheadSec);
    if (end === -1) end = items.length;
    return { start, end };
  }

  function scheduleAroundPlayhead(session, video, options) {
    if (!session || !video) return { start: 0, end: 0, scheduled: [] };
    const config = playbackConfig(session);
    const opts = options || {};
    const window = findScheduleWindow(
      session.sentences,
      video.currentTime,
      opts.lookaheadMs == null ? config.lookaheadMs : opts.lookaheadMs
    );
    const scheduled = scheduleWindow(session, window.start, window.end, opts);
    return { ...window, scheduled };
  }

  return {
    decodeCompleteAudio,
    scheduleWindow,
    resyncPendingSources,
    cancelPendingSources,
    findScheduleWindow,
    scheduleAroundPlayhead
  };
});
