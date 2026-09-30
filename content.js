(function initSubToVoiceContent() {
  "use strict";

  if (globalThis.__SUB_TO_VOICE_CONTENT_LOADED__) return;
  globalThis.__SUB_TO_VOICE_CONTENT_LOADED__ = true;

  const CaptionCore = globalThis.SubToVoiceCaptionCore;
  if (!CaptionCore) throw new Error("Sub-to-Voice caption core did not load.");
  const ProviderClient = globalThis.SubToVoiceProviderClient;
  if (!ProviderClient) throw new Error("Sub-to-Voice provider client did not load.");
  const AudioScheduler = globalThis.SubToVoiceAudioScheduler;
  if (!AudioScheduler) throw new Error("Sub-to-Voice audio scheduler did not load.");

  const DEFAULT_RENDER_CONCURRENCY = 5;
  const VOICE_GAIN_MAX = 2;
  const PROBE_LAYOUT_KEY = "stv-probe-layout";

  const YT_CC_BUTTON_SELECTORS = [
    "button.ytp-subtitles-button",
    ".ytp-chrome-controls .ytp-subtitles-button",
    'button[aria-label*="captions" i]',
    'button[aria-label*="subtitle" i]'
  ];

  let session = null;
  let lastUrl = location.href;
  let cachedCaptions = null;
  let lastTranscript = null;
  let probeResizeObserver = null;

  function saveProbeLayout(root) {
    try {
      const rect = root.getBoundingClientRect();
      localStorage.setItem(PROBE_LAYOUT_KEY, JSON.stringify({
        left: rect.left, top: rect.top, width: rect.width, height: rect.height
      }));
    } catch {
      // The overlay still works when page storage is unavailable.
    }
  }

  function setupProbeLayout(root) {
    try {
      const saved = JSON.parse(localStorage.getItem(PROBE_LAYOUT_KEY) || "null");
      if (saved && [saved.left, saved.top, saved.width, saved.height].every(Number.isFinite)) {
        root.style.width = Math.max(220, Math.min(saved.width, innerWidth)) + "px";
        root.style.height = Math.max(90, Math.min(saved.height, innerHeight)) + "px";
        root.style.left = Math.max(0, Math.min(saved.left, innerWidth - root.offsetWidth)) + "px";
        root.style.top = Math.max(0, Math.min(saved.top, innerHeight - root.offsetHeight)) + "px";
        root.style.right = "auto";
      }
    } catch {
      // Ignore invalid or unavailable saved layout.
    }

    root.querySelector("strong").addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const rect = root.getBoundingClientRect();
      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;
      const move = (next) => {
        root.style.left = Math.max(0, Math.min(next.clientX - offsetX, innerWidth - root.offsetWidth)) + "px";
        root.style.top = Math.max(0, Math.min(next.clientY - offsetY, innerHeight - root.offsetHeight)) + "px";
        root.style.right = "auto";
      };
      const stop = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
        saveProbeLayout(root);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
    });

    if (typeof ResizeObserver !== "undefined") {
      probeResizeObserver = new ResizeObserver(() => saveProbeLayout(root));
      probeResizeObserver.observe(root);
    }
  }

  function getYouTubeVideoId() {
    try {
      const url = new URL(location.href);
      const videoId = url.searchParams.get("v");
      if (videoId) return videoId;
      const embedded = url.pathname.match(/\/embed\/([^/?]+)/);
      return embedded ? embedded[1] : null;
    } catch {
      return null;
    }
  }

  function findVideo() {
    return document.querySelector("video.html5-main-video, video");
  }

  function findYTCCButton() {
    for (const selector of YT_CC_BUTTON_SELECTORS) {
      const button = document.querySelector(selector);
      if (button) return button;
    }
    return null;
  }

  function triggerYTCCLoad() {
    const button = findYTCCButton();
    if (!button) return { triggered: false, wasOff: false };
    const wasOff = button.getAttribute("aria-pressed") !== "true";
    if (wasOff) {
      try {
        button.click();
      } catch {
        return { triggered: false, wasOff };
      }
    }
    return { triggered: true, wasOff };
  }

  function restoreYTCCButton(wasOff) {
    if (!wasOff) return;
    const button = findYTCCButton();
    if (button && button.getAttribute("aria-pressed") === "true") {
      try {
        button.click();
      } catch {
        // Best effort only.
      }
    }
  }

  async function fetchCCViaIntercept(videoId, signal, timeoutMs) {
    const waitMs = timeoutMs == null ? 1800 : timeoutMs;
    const askBackground = () => new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: "GET_YT_CC_URL", videoId },
          (reply) => resolve(reply?.ok ? reply : null)
        );
      } catch {
        resolve(null);
      }
    });

    let entry = await askBackground();
    if (entry?.url) return entry;
    if (signal?.aborted) return null;

    const trigger = triggerYTCCLoad();
    if (!trigger.triggered) return null;

    const startedAt = Date.now();
    while (Date.now() - startedAt < waitMs) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (signal?.aborted) {
        restoreYTCCButton(trigger.wasOff);
        return null;
      }
      entry = await askBackground();
      if (entry?.url) {
        restoreYTCCButton(trigger.wasOff);
        return entry;
      }
    }

    restoreYTCCButton(trigger.wasOff);
    return null;
  }

  function readPlayerResponseFromDom() {
    const scripts = document.querySelectorAll("script");
    for (const script of scripts) {
      const textContent = script.textContent;
      if (!textContent || !textContent.includes("ytInitialPlayerResponse")) continue;

      const marker = "ytInitialPlayerResponse";
      const markerIndex = textContent.indexOf(marker);
      const equalsIndex = textContent.indexOf("=", markerIndex + marker.length);
      const braceIndex = textContent.indexOf("{", equalsIndex + 1);
      if (equalsIndex === -1 || braceIndex === -1) continue;

      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let index = braceIndex; index < textContent.length; index += 1) {
        const char = textContent[index];
        if (inString) {
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === '"') inString = false;
          continue;
        }
        if (char === '"') {
          inString = true;
          continue;
        }
        if (char === "{") depth += 1;
        if (char === "}") {
          depth -= 1;
          if (depth === 0) {
            try {
              return JSON.parse(textContent.slice(braceIndex, index + 1));
            } catch {
              break;
            }
          }
        }
      }
    }
    return null;
  }

  function pickCaptionTrack(tracks, targetLanguage) {
    if (!Array.isArray(tracks) || tracks.length === 0) return null;
    const targetCode = String(targetLanguage || "vi").toLowerCase().split("-")[0];
    const score = (track) => {
      const code = String(track.languageCode || "").toLowerCase().split("-")[0];
      let value = 0;
      if (code === targetCode) value += 100;
      if (code === "en") value += 50;
      if (track.kind !== "asr") value += 10;
      return value;
    };
    return [...tracks].sort((a, b) => score(b) - score(a))[0];
  }

  async function fetchJson3(url, signal, kind) {
    const target = url.includes("fmt=") ? url : url + "&fmt=json3";
    const response = await fetch(target, { credentials: "include", signal });
    if (!response.ok) return null;
    const json = await response.json().catch(() => null);
    const isAsr = kind === "asr" || new URL(target).searchParams.get("kind") === "asr";
    const captions = CaptionCore.parseJson3Events(json?.events || [], { isAsr });
    const rawCaptions = (json?.events || []).filter((event) =>
      Number.isFinite(event?.tStartMs) && Array.isArray(event.segs)
    ).map((event) => ({
      start: event.tStartMs / 1000,
      end: (event.tStartMs + (event.dDurationMs || 0)) / 1000,
      text: event.segs.map((segment) => segment.utf8 || "").join("")
        .replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()
    })).filter((caption) => caption.text);
    return captions.length ? { captions, rawCaptions, sourceUrl: target, kind: isAsr ? "asr" : null } : null;
  }

  async function fetchYouTubeCaptions(videoId, targetLanguage, signal) {
    try {
      const intercepted = await fetchCCViaIntercept(videoId, signal);
      if (intercepted?.url) {
        const result = await fetchJson3(intercepted.url, signal, intercepted.kind);
        if (result) {
          return {
            ...result,
            lang: intercepted.lang,
            kind: intercepted.kind || result.kind,
            source: "intercept"
          };
        }
      }
    } catch {
      if (signal?.aborted) return null;
    }

    const playerResponse = readPlayerResponseFromDom();
    const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    const picked = pickCaptionTrack(tracks, targetLanguage);
    if (picked?.baseUrl) {
      try {
        const result = await fetchJson3(picked.baseUrl, signal, picked.kind);
        if (result) {
          return {
            ...result,
            lang: picked.languageCode,
            kind: picked.kind || result.kind,
            source: "player-response"
          };
        }
      } catch {
        if (signal?.aborted) return null;
      }
    }

    const base = "https://www.youtube.com/api/timedtext";
    const encodedVideoId = encodeURIComponent(videoId);
    const encodedTarget = encodeURIComponent(targetLanguage || "vi");
    const fallbackUrls = [
      base + "?lang=en&v=" + encodedVideoId + "&fmt=json3",
      base + "?lang=" + encodedTarget + "&v=" + encodedVideoId + "&fmt=json3",
      base + "?lang=en&v=" + encodedVideoId + "&fmt=json3&kind=asr"
    ];

    for (const url of fallbackUrls) {
      try {
        const result = await fetchJson3(url, signal);
        if (result) return { ...result, source: "plain-fallback" };
      } catch {
        if (signal?.aborted) return null;
      }
    }
    return null;
  }

  function ensureProbe() {
    let root = document.getElementById("stv-probe");
    if (root) return root;
    root = document.createElement("div");
    root.id = "stv-probe";
    root.innerHTML = [
      "<strong>Sub-to-Voice Pro</strong>",
      '<div data-stv-status>Ready</div>',
      '<div data-stv-sample></div>'
    ].join("");
    document.documentElement.appendChild(root);
    setupProbeLayout(root);
    return root;
  }

  function setProbe(status, sample) {
    const root = ensureProbe();
    const statusNode = root.querySelector("[data-stv-status]");
    const sampleNode = root.querySelector("[data-stv-sample]");
    if (statusNode) statusNode.textContent = status;
    if (sampleNode) sampleNode.textContent = sample || "";
  }

  function removeProbe() {
    probeResizeObserver?.disconnect();
    probeResizeObserver = null;
    document.getElementById("stv-probe")?.remove();
  }

  function emitState(partial) {
    chrome.runtime.sendMessage({ type: "CONTENT_STATE", ...partial }).catch(() => {});
  }

  function computeGain(voiceVolume) {
    return voiceVolume === 0 ? 0 : ((voiceVolume ?? 100) / 100) * VOICE_GAIN_MAX;
  }

  function applyVolumes(current) {
    const originalVolume = Math.max(0, Math.min(1, (current.settings.originalVolume ?? 18) / 100));
    current.video.volume = originalVolume;
    current.video.muted = originalVolume === 0;
    current.outputGain.gain.value = computeGain(current.settings.voiceVolume ?? 100);
  }

  function recordScheduledAudio(current, scheduled) {
    for (const item of scheduled || []) {
      const start = Math.max(0, item.playAt - current.audioOffset);
      const record = {
        index: item.index, source: item.source, start,
        end: start + item.duration, closed: false
      };
      current.audioTimings.push(record);
      current.audioTimingBySource.set(item.source, record);
    }
  }

  function closeScheduledAudio(current) {
    const now = current.video.currentTime;
    for (const item of current.audioTimings) {
      if (item.closed) continue;
      if (!Number.isFinite(now) || now <= item.start) {
        item.discarded = true;
      } else {
        item.end = Math.min(item.end, now);
      }
      item.closed = true;
    }
  }

  function discardPendingAudio(current) {
    for (const item of current.audioTimings) {
      if (!item.closed) {
        item.closed = true;
        item.discarded = true;
      }
    }
  }

  function transcriptSnapshot(current) {
    const now = current.video.currentTime;
    const startedAt = current.logStart;
    const inWindow = (item) => item.end > item.start
      ? item.start < now && item.end > startedAt
      : item.start >= startedAt && item.start <= now;
    const { groups, orphans } = CaptionCore.assignRawCaptions(current.rawCaptions, current.sentences);
    return {
      videoId: current.videoId,
      windowStart: startedAt,
      windowEnd: now,
      rows: current.sentences.map((sentence, index) => ({
        sortAt: sentence.start,
        originals: groups[index].filter(inWindow),
        processed: sentence.text,
        translation: current.translations[index] || null,
        audio: current.audioTimings.filter((item) =>
          item.index === index && !item.discarded &&
          (item.closed || item.start <= now) && current.translations[index] &&
          item.start < now && item.end > startedAt
        ).map((item) => ({
          start: Math.max(item.start, startedAt),
          end: Math.min(item.end, now),
          text: current.translations[index]
        })).filter((item) => item.end > item.start)
      })).filter((row, index) => inWindow(current.sentences[index])).concat(orphans.filter(inWindow).map((caption) => ({
        sortAt: caption.start, originals: [caption], processed: null, translation: null, audio: []
      }))).sort((a, b) => a.sortAt - b.sortAt)
    };
  }

  async function translateBatch(current, startIdx, endIdx) {
    if (current !== session || current.stopFlag || startIdx >= endIdx) return;
    const slice = current.sentences.slice(startIdx, endIdx);
    const lines = await ProviderClient.translateBatch({
      lines: slice.map((sentence) => sentence.text),
      sourceLanguage: current.settings.sourceLanguage || "auto",
      targetLanguage: current.settings.targetLanguage || "vi",
      signal: current.abortController.signal
    });
    if (current !== session || current.stopFlag) return;
    for (let index = 0; index < lines.length; index += 1) {
      current.translations[startIdx + index] = lines[index];
    }
  }

  async function labelSpeakerWave(current, startIdx, endIdx) {
    if (!current.settings.multiVoice || current.speakerLabelingUnavailable) return;
    const chunkSize = Math.max(1, Math.floor(current.settings.speakerChunkSize || 24));
    const contextSize = Math.max(0, Math.floor(current.settings.speakerContextSize || 8));
    const target = Math.min(current.sentences.length, Math.max(endIdx, startIdx + chunkSize));
    for (let start = startIdx; start < target;) {
      if (current !== session || current.stopFlag) return;
      if (current.speakers[start]) {
        start += 1;
        continue;
      }
      const end = Math.min(start + chunkSize, target);
      const lines = current.sentences.slice(start, end).map((sentence, offset) => ({
        id: start + offset + 1, text: sentence.text
      }));
      const context = current.speakers.slice(Math.max(0, start - contextSize), start)
        .map((speaker, offset) => ({
          id: Math.max(0, start - contextSize) + offset + 1,
          text: current.sentences[Math.max(0, start - contextSize) + offset].text,
          speaker
        })).filter((item) => item.speaker);
      try {
        const labels = await ProviderClient.labelSpeakers({
          lines, context, signal: current.abortController.signal
        });
        if (current !== session || current.stopFlag) return;
        if (!Array.isArray(labels) || labels.length !== lines.length) throw new Error("Invalid speaker labels.");
        for (let offset = 0; offset < labels.length; offset += 1) {
          current.speakers[start + offset] = labels[offset];
        }
        emitState({ detectedSpeakers: [...new Set(current.speakers.filter((label) =>
          /^S[1-9]\d*$/.test(label || "")))].sort((a, b) =>
          Number(a.slice(1)) - Number(b.slice(1))) });
        start = end;
      } catch (error) {
        if (current.abortController.signal.aborted) return;
        current.speakerLabelingUnavailable = true;
        console.warn("Speaker labeling unavailable; using the default voice.", error);
        return;
      }
    }
  }

  async function renderWaveTTS(current, startIdx, endIdx) {
    const queue = [];
    for (let index = startIdx; index < endIdx; index += 1) {
      if (!current.sentences[index]?._buffer && current.translations[index]) {
        queue.push(index);
      }
    }

    let cursor = 0;
    const renderConcurrency = Math.max(
      1,
      Math.floor(current.settings.ttsConcurrency ?? DEFAULT_RENDER_CONCURRENCY)
    );
    const workers = Array.from(
      { length: Math.min(renderConcurrency, queue.length) },
      async () => {
        while (cursor < queue.length) {
          if (current !== session || current.stopFlag) return;
          const index = queue[cursor++];
          const result = await ProviderClient.synthesize({
            text: current.translations[index],
            voice: current.settings.voice,
            speaker: current.speakers[index] || "U",
            speed: current.settings.speed,
            signal: current.abortController.signal
          });
          if (current !== session || current.stopFlag) return;
          current.sentences[index]._buffer = await AudioScheduler.decodeCompleteAudio(
            current.audioCtx,
            result.audio
          );
        }
      }
    );
    await Promise.all(workers);
  }

  function updateLiveDisplay(current) {
    if (current !== session) return;
    const now = current.video.currentTime;
    const index = current.sentences.findIndex(
      (sentence) => sentence.start <= now && sentence.end >= now
    );
    if (index === -1) return;
    const translated = current.translations[index];
    const source = current.sentences[index].text;
    setProbe(
      "Translating · " + Math.round(now) + "s",
      source + (translated ? "\n→ " + translated : "")
    );
  }

  async function runRollingRenderer(current) {
    while (current === session && !current.stopFlag) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (current !== session || current.stopFlag) return;
      if (current.paused) {
        updateLiveDisplay(current);
        continue;
      }

      const videoTime = current.video.currentTime;
      const horizon = videoTime + (AudioScheduler.LOOKAHEAD_MS / 1000);
      let targetIdx = current.sentences.findIndex((sentence) => sentence.start > horizon);
      if (targetIdx === -1) targetIdx = current.sentences.length;
      if (targetIdx <= current.renderCursor) {
        updateLiveDisplay(current);
        continue;
      }

      const start = current.renderCursor;
      const end = targetIdx;
      try {
        const firstUntranslated = current.translations.findIndex(
          (value, index) => index >= start && index < end && !value
        );
        if (firstUntranslated !== -1) {
          await Promise.all([
            translateBatch(current, firstUntranslated, end),
            labelSpeakerWave(current, start, end)
          ]);
        } else {
          await labelSpeakerWave(current, start, end);
        }
        if (current !== session || current.stopFlag) return;
        await renderWaveTTS(current, start, end);
        if (current !== session || current.stopFlag) return;
        recordScheduledAudio(current, AudioScheduler.scheduleWindow(current, start, end));
        current.renderCursor = end;
        updateLiveDisplay(current);
      } catch (error) {
        if (current !== session || current.stopFlag) return;
        const message = error?.message || String(error);
        stopSession("Dub render failed", false, false);
        setProbe("Dub render failed", message);
        emitState({ running: false, status: "Dub render failed", errorMessage: message });
        return;
      }
    }
  }

  function firstWaveBounds(sentences, currentTime) {
    let start = sentences.findIndex((sentence) => sentence.start >= currentTime);
    if (start === -1) start = sentences.length;
    const horizon = currentTime + (AudioScheduler.LOOKAHEAD_MS / 1000);
    let lookaheadEnd = sentences.findIndex((sentence) => sentence.start > horizon);
    if (lookaheadEnd === -1) lookaheadEnd = sentences.length;
    let end = Math.min(lookaheadEnd, start + 2);
    if (end <= start && start < sentences.length) end = start + 1;
    return { start, end };
  }

  async function startSubtitleFirstSession() {
    stopSession("restart", false);
    lastTranscript = null;
    const video = findVideo();
    if (!video) return { ok: false, error: "No video on this page." };

    const videoId = getYouTubeVideoId();
    if (!videoId) return { ok: false, error: "Could not detect YouTube video id." };

    let settings = null;
    try {
      settings = await ProviderClient.getRuntimeSettings();
    } catch (error) {
      session = null;
      const message = error?.message || String(error);
      setProbe(message);
      emitState({ running: false, status: "Configuration error", errorMessage: message });
      return { ok: false, error: message };
    }

    let audioCtx;
    let outputGain;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") await audioCtx.resume().catch(() => {});
      outputGain = audioCtx.createGain();
      outputGain.gain.value = computeGain(settings.voiceVolume ?? 100);
      outputGain.connect(audioCtx.destination);
    } catch (error) {
      const message = "AudioContext unavailable: " + (error?.message || String(error));
      setProbe(message);
      return { ok: false, error: message };
    }

    const abortController = new AbortController();
    const current = {
      video,
      videoId,
      logStart: video.currentTime,
      settings,
      audioCtx,
      outputGain,
      abortController,
      sentences: [],
      rawCaptions: [],
      translations: [],
      speakers: [],
      speakerLabelingUnavailable: false,
      audioTimings: [],
      audioTimingBySource: new WeakMap(),
      pendingSources: [],
      scheduledSentenceIndexes: new Set(),
      audioOffset: 0,
      renderCursor: 0,
      stopFlag: false,
      paused: false,
      startupPreparing: true,
      source: null,
      wasPlaying: !video.paused,
      originalVolume: video.volume,
      originalMuted: video.muted,
      _onPause: null,
      _onPlay: null,
      _onSeeked: null,
      _onEnded: null
    };
    session = current;
    setProbe("Loading captions…");
    try { video.pause(); } catch {}

    const targetLanguage = settings.targetLanguage || "vi";
    let result = cachedCaptions?.videoId === videoId &&
      cachedCaptions.targetLanguage === targetLanguage
      ? cachedCaptions.result : null;
    if (!result) {
      try {
        result = await fetchYouTubeCaptions(videoId, targetLanguage, abortController.signal);
        if (result?.captions?.length) cachedCaptions = { videoId, targetLanguage, result };
      } catch {
        result = null;
      }
    }

    if (session !== current || abortController.signal.aborted) {
      try { audioCtx.close(); } catch {}
      return { ok: false, error: "Cancelled." };
    }

    if (!result?.captions?.length) {
      session = null;
      try { audioCtx.close(); } catch {}
      if (current.wasPlaying) {
        try { await video.play(); } catch {}
      }
      const message = "This phase requires a YouTube caption track.";
      setProbe(message);
      emitState({ running: false, status: "No captions", errorMessage: message });
      return { ok: false, error: message };
    }

    const sentences = result.kind === "asr"
      ? result.captions.map((caption) => ({ ...caption }))
      : CaptionCore.regroupToSentences(result.captions);
    current.sentences = sentences;
    current.rawCaptions = result.rawCaptions || result.captions;
    current.translations = new Array(sentences.length);
    current.source = result.source;
    const firstWave = firstWaveBounds(sentences, video.currentTime);
    if (firstWave.start >= firstWave.end) {
      session = null;
      try { audioCtx.close(); } catch {}
      if (current.wasPlaying) {
        try { await video.play(); } catch {}
      }
      const message = "No forward captions remain at this playhead.";
      setProbe(message);
      return { ok: false, error: message };
    }

    try {
      setProbe("Translating first wave…");
      await Promise.all([
        translateBatch(current, firstWave.start, firstWave.end),
        labelSpeakerWave(current, firstWave.start, firstWave.end)
      ]);
      if (current !== session || current.stopFlag) return { ok: false, error: "Cancelled." };
      setProbe("Preparing voices…");
      await renderWaveTTS(current, firstWave.start, firstWave.end);
    } catch (error) {
      if (current !== session || current.stopFlag || abortController.signal.aborted) {
        return { ok: false, error: "Cancelled." };
      }
      session = null;
      try { audioCtx.close(); } catch {}
      video.volume = current.originalVolume;
      video.muted = current.originalMuted;
      if (current.wasPlaying) {
        try { await video.play(); } catch {}
      }
      const message = error?.message || String(error);
      setProbe("Dub startup failed", message);
      emitState({ running: false, status: "Dub startup failed", errorMessage: message });
      return { ok: false, error: message };
    }

    current.audioOffset = AudioScheduler.computeAudioOffset(
      audioCtx.currentTime,
      video.currentTime
    );
    current.onAudioEnded = (source) => {
      const record = current.audioTimingBySource.get(source);
      if (record) record.closed = true;
    };
    recordScheduledAudio(current, AudioScheduler.scheduleWindow(current, firstWave.start, firstWave.end));
    current.renderCursor = firstWave.end;
    applyVolumes(current);

    const onPause = () => {
      if (current !== session || current.stopFlag) return;
      current.paused = true;
      closeScheduledAudio(current);
      AudioScheduler.cancelPendingSources(current);
      void current.audioCtx.suspend().catch(() => {});
      setProbe("Paused");
      emitState({ running: true, paused: true, status: "Paused", errorMessage: "" });
    };
    const onPlay = async () => {
      if (current !== session || current.stopFlag) return;
      current.paused = false;
      discardPendingAudio(current);
      AudioScheduler.cancelPendingSources(current);
      await current.audioCtx.resume().catch(() => {});
      if (current !== session || current.stopFlag) return;
      current.audioOffset = AudioScheduler.computeAudioOffset(
        current.audioCtx.currentTime,
        current.video.currentTime
      );
      const window = AudioScheduler.scheduleAroundPlayhead(current, current.video);
      recordScheduledAudio(current, window.scheduled);
      if (window.start < current.renderCursor) current.renderCursor = window.start;
      updateLiveDisplay(current);
      emitState({ running: true, paused: false, status: "Translating", errorMessage: "" });
    };
    const onSeeked = () => {
      if (current !== session || current.stopFlag) return;
      discardPendingAudio(current);
      AudioScheduler.cancelPendingSources(current);
      current.audioOffset = AudioScheduler.computeAudioOffset(
        current.audioCtx.currentTime,
        current.video.currentTime
      );
      const window = AudioScheduler.scheduleAroundPlayhead(current, current.video);
      recordScheduledAudio(current, window.scheduled);
      if (window.start < current.renderCursor) current.renderCursor = window.start;
      updateLiveDisplay(current);
    };
    const onEnded = () => {
      stopSession("Video ended.");
    };
    current._onPause = onPause;
    current._onPlay = onPlay;
    current._onSeeked = onSeeked;
    current._onEnded = onEnded;
    video.addEventListener("pause", onPause);
    video.addEventListener("play", onPlay);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("ended", onEnded);

    if (current.wasPlaying) {
      try { await video.play(); } catch {}
    }
    current.startupPreparing = false;
    setProbe("Translating");
    emitState({ running: true, status: "Translating", errorMessage: "" });
    void runRollingRenderer(current);
    return { ok: true, status: "Translating", count: sentences.length };
  }

  function stopSession(reason, remove, notify) {
    const stopReason = reason || "Stopped";
    const shouldRemove = remove !== false;
    const current = session;
    if (current) {
      closeScheduledAudio(current);
      lastTranscript = transcriptSnapshot(current);
      current.stopFlag = true;
      try { current.abortController.abort(); } catch {}
      AudioScheduler.cancelPendingSources(current);
      if (current._onPause) {
        try { current.video.removeEventListener("pause", current._onPause); } catch {}
      }
      if (current._onPlay) {
        try { current.video.removeEventListener("play", current._onPlay); } catch {}
      }
      if (current._onSeeked) {
        try { current.video.removeEventListener("seeked", current._onSeeked); } catch {}
      }
      if (current._onEnded) {
        try { current.video.removeEventListener("ended", current._onEnded); } catch {}
      }
      try { current.outputGain.disconnect(); } catch {}
      try { current.audioCtx.close(); } catch {}
      try {
        current.video.volume = current.originalVolume;
        current.video.muted = current.originalMuted;
      } catch {}
      if (current.startupPreparing && current.wasPlaying && current.video.paused) {
        try { void current.video.play().catch(() => {}); } catch {}
      }
    }
    session = null;
    if (shouldRemove) removeProbe();
    if (stopReason !== "restart" && notify !== false) {
      emitState({ running: false, status: stopReason, errorMessage: "" });
    }
  }

  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    if (cachedCaptions && cachedCaptions.videoId !== getYouTubeVideoId()) cachedCaptions = null;
    if (session) stopSession("YouTube navigated.");
  }, 500);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      switch (message?.type) {
        case "CONTENT_PING":
          sendResponse({ ok: true, version: "0.1.0" });
          break;
        case "CONTENT_START":
          sendResponse(await startSubtitleFirstSession());
          break;
        case "CONTENT_STOP":
          stopSession();
          sendResponse({ ok: true });
          break;
        case "CONTENT_SET_ORIGINAL_VOLUME":
          if (session) {
            session.settings.originalVolume = message.volume;
            applyVolumes(session);
          }
          sendResponse({ ok: true });
          break;
        case "CONTENT_GET_TRANSCRIPT":
          sendResponse({ ok: true, transcript: session ? transcriptSnapshot(session) : lastTranscript });
          break;
        default:
          sendResponse({ ok: false, error: "Unknown content message: " + message?.type });
      }
    })();
    return true;
  });
})();
