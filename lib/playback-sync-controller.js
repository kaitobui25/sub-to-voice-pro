(function initPlaybackSyncController(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SubToVoicePlaybackSyncController = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function playbackSyncControllerFactory() {
  "use strict";

  function refreshPlaybackAnchor(options) {
    const opts = options || {};
    const video = opts.video;
    const audioCtx = opts.audioCtx;
    const clock = opts.clock;
    if (!video || !audioCtx || !clock || typeof clock.refresh !== "function") {
      throw new TypeError("Playback anchor refresh requires video, AudioContext and playback clock.");
    }
    const resolveRate = typeof opts.resolveRate === "function"
      ? opts.resolveRate
      : (value) => Number(value) || 1;
    return clock.refresh({
      videoTime: video.currentTime,
      audioTime: audioCtx.currentTime,
      rate: resolveRate(video.playbackRate)
    });
  }

  function createPlaybackSyncController(options) {
    const opts = options || {};
    const video = opts.video;
    const audioCtx = opts.audioCtx;
    const clock = opts.clock;
    if (!video || typeof video.addEventListener !== "function") {
      throw new TypeError("Playback sync controller requires a video element.");
    }
    if (!audioCtx || !clock || typeof clock.refresh !== "function") {
      throw new TypeError("Playback sync controller requires an AudioContext and playback clock.");
    }

    let attached = false;

    function refreshAnchor() {
      return refreshPlaybackAnchor({
        video,
        audioCtx,
        clock,
        resolveRate: opts.resolveRate
      });
    }

    const listeners = {
      pause: (event) => opts.onPause?.(event),
      play: (event) => opts.onPlay?.(event),
      seeked: (event) => opts.onSeeked?.(event),
      ratechange: (event) => opts.onRateChange?.(event),
      ended: (event) => opts.onEnded?.(event)
    };

    function attach() {
      if (attached) return;
      for (const [name, handler] of Object.entries(listeners)) {
        video.addEventListener(name, handler);
      }
      attached = true;
    }

    function detach() {
      if (!attached) return;
      for (const [name, handler] of Object.entries(listeners)) {
        try { video.removeEventListener(name, handler); } catch {}
      }
      attached = false;
    }

    return { attach, detach, refreshAnchor };
  }

  return { refreshPlaybackAnchor, createPlaybackSyncController };
});
