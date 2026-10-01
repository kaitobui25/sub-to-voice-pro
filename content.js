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

  function traceFor(current, index) {
    return current.diagnostics[index] ||= { startedAt: globalThis.performance?.now?.() ?? Date.now() };
  }

  function traceTime(trace) {
    return Math.max(0, ((globalThis.performance?.now?.() ?? Date.now()) - trace.startedAt) / 1000);
  }

  function scheduleWithTrace(current, start, end) {
    return AudioScheduler.scheduleWindow(current, start, end, {
      onDecision: (decision) => recordScheduleDecision(current, decision)
    });
  }

  function recordScheduleDecision(current, decision) {
    const trace = traceFor(current, decision.index);
    trace.schedule = { ...decision, at: traceTime(trace) };
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
        recordScheduleDecision(current, { index: item.index, status: "cancelled", videoTime: now });
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
        recordScheduleDecision(current, { index: item.index, status: "cancelled",
          videoTime: current.video.currentTime });
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
      speakerRequestCount: current.speakerRequestCount || 0,
      speakerFallbackBatchCount: current.speakerFallbackBatchCount || 0,
      rows: current.sentences.map((sentence, index) => ({
        sortAt: sentence.start,
        start: sentence.start,
        originals: groups[index].filter(inWindow),
        processed: sentence.text,
        translation: current.translations[index] || null,
        id: index + 1,
        diagnostic: current.diagnostics[index] ? { ...current.diagnostics[index] } : null,
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
    for (let index = startIdx; index < endIdx; index += 1) {
      const trace = traceFor(current, index);
      if (trace.translationStart == null) trace.translationStart = traceTime(trace);
    }
    const slice = current.sentences.slice(startIdx, endIdx);
    const signal = current.prepareAbortController.signal;
    let lines;
    try {
      lines = await ProviderClient.translateBatch({
        lines: slice.map((sentence) => sentence.text),
        sourceLanguage: current.settings.sourceLanguage || "auto",
        targetLanguage: current.settings.targetLanguage || "vi",
        signal
      });
    } catch (error) {
      if (!signal.aborted) {
        for (let index = startIdx; index < endIdx; index += 1) {
          traceFor(current, index).translationError = error?.message || String(error);
        }
      }
      throw error;
    }
    if (current !== session || current.stopFlag || signal.aborted) return;
    for (let index = 0; index < lines.length; index += 1) {
      current.translations[startIdx + index] = lines[index];
      const trace = traceFor(current, startIdx + index);
      if (trace.translationEnd == null) trace.translationEnd = traceTime(trace);
      delete trace.translationError;
    }
  }

  function normalizeSpeakerLabel(current, rawLabel) {
    const voiceCount = Math.max(0, Math.floor(current.settings.speakerVoiceCount || 0));
    const match = String(rawLabel || "").match(/^S([1-9]\d*)$/);
    return match && voiceCount > 0
      ? "S" + (((Number(match[1]) - 1) % voiceCount) + 1)
      : rawLabel;
  }

  function emitDetectedSpeakers(current) {
    emitState({ detectedSpeakers: [...new Set(current.speakers.filter((label) =>
      /^S[1-9]\d*$/.test(label || "")))].sort((a, b) =>
      Number(a.slice(1)) - Number(b.slice(1))) });
  }

  function applySpeakerLabels(current, start, labels, fallbackError) {
    for (let offset = 0; offset < labels.length; offset += 1) {
      const label = normalizeSpeakerLabel(current, labels[offset]);
      current.speakers[start + offset] = label;
      const trace = traceFor(current, start + offset);
      trace.speaker = label;
      trace.speakerEnd = traceTime(trace);
      if (fallbackError) {
        trace.speakerFallback = fallbackError;
        delete trace.speakerError;
      } else {
        delete trace.speakerFallback;
        delete trace.speakerError;
      }
    }
    emitDetectedSpeakers(current);
  }

  function speakerMarker(text) {
    const match = String(text || "").match(/^\s*([A-Za-z][A-Za-z0-9 .'-]{0,24}):\s*/);
    return match ? match[1].trim().toLowerCase() : "";
  }

  const SPEAKER_NAME_STOPWORDS = new Set([
    "a", "an", "the", "fine", "glad", "happy", "ready", "sure", "here", "currently",
    "recently", "really", "very", "looking", "going", "trying", "interested", "working"
  ]);

  function selfIntroductionName(text) {
    const value = String(text || "");
    const match = value.match(/\b(?:I'm|I am|my name is|this is)\s+([A-Za-z][A-Za-z'-]{1,24})\b/);
    if (!match) return "";
    const name = match[1].toLowerCase();
    return SPEAKER_NAME_STOPWORDS.has(name) ? "" : name;
  }

  function questionCueIndex(text) {
    const value = String(text || "").toLowerCase();
    const patterns = [
      /\bhow\b/, /\bwhat\b/, /\bwhy\b/, /\bwhen\b/, /\bwhere\b/, /\bwho\b/, /\bwhich\b/,
      /\bcould you\b/, /\bwould you\b/, /\bcan you\b/, /\btell me\b/, /\bdo you\b/,
      /\bdid you\b/, /\bhave you\b/, /\bare you\b/, /\bwere you\b/, /\bdescribe\b/,
      /\bwalk me through\b/, /\bgive me\b/
    ];
    let found = -1;
    for (const pattern of patterns) {
      const match = pattern.exec(value);
      if (match && (found === -1 || match.index < found)) found = match.index;
    }
    return found;
  }

  function fallbackSpeakerLabels(current, lines, context) {
    const voiceCount = Math.max(1, Math.floor(current.settings.speakerVoiceCount || 1));
    const markerLabels = current.speakerMarkerLabels ||= new Map();
    const normalizeKnown = (label) => {
      const normalized = normalizeSpeakerLabel(current, label);
      return /^S[1-9]\d*$/.test(normalized || "") ? normalized : null;
    };
    const nextLabel = (label) => {
      const match = String(label || "").match(/^S([1-9]\d*)$/);
      const index = match ? Number(match[1]) : 1;
      return "S" + ((index % voiceCount) + 1);
    };

    const assignIdentity = (identity) => {
      if (!identity) return null;
      if (markerLabels.has(identity)) return markerLabels.get(identity);
      const used = new Set(markerLabels.values());
      let label = null;
      for (let index = 1; index <= voiceCount; index += 1) {
        const candidate = "S" + index;
        if (!used.has(candidate)) {
          label = candidate;
          break;
        }
      }
      label ||= "S" + ((markerLabels.size % voiceCount) + 1);
      markerLabels.set(identity, label);
      return label;
    };

    for (const item of context) {
      const marker = speakerMarker(item.text);
      const label = normalizeKnown(item.speaker);
      if (marker && label) markerLabels.set(marker, label);
      const intro = selfIntroductionName(item.text);
      if (intro && label) markerLabels.set(intro, label);
    }

    const previous = [...context].reverse().find((item) => normalizeKnown(item.speaker));
    let active = previous ? normalizeKnown(previous.speaker) : "S1";
    if (previous && /\?\s*$/.test(previous.text || "") && voiceCount > 1) {
      active = nextLabel(active);
    }

    return lines.map((line) => {
      const marker = speakerMarker(line.text);
      const intro = selfIntroductionName(line.text);
      let label = marker ? assignIdentity(marker) : intro ? assignIdentity(intro) : null;

      if (!label && voiceCount > 1) {
        const value = String(line.text || "").toLowerCase();
        const directlyAddressed = [...markerLabels.entries()].find(([identity]) =>
          identity && new RegExp("\\b" + identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i").test(value)
        );
        if (directlyAddressed) label = nextLabel(directlyAddressed[1]);
      }

      const questionAt = questionCueIndex(line.text);
      if (!label && questionAt >= 0 && voiceCount > 1) {
        // A question/request that appears after answer-like text usually marks
        // a turn boundary inside YouTube's punctuation-free ASR sentence.
        label = questionAt > 18 ? nextLabel(active) : active;
      }

      label ||= active;

      // The next line after a question/request is normally the other speaker.
      active = questionAt >= 0 && voiceCount > 1 ? nextLabel(label) : label;
      return label;
    });
  }

  function speakerContext(current, start) {
    const contextSize = Math.max(0, Math.floor(current.settings.speakerContextSize || 16));
    const contextStart = Math.max(0, start - contextSize);
    return current.speakers.slice(contextStart, start)
      .map((speaker, offset) => ({
        id: contextStart + offset + 1,
        text: current.sentences[contextStart + offset].text,
        speaker
      })).filter((item) => item.speaker);
  }

  function speakerBatch(current, start) {
    const maxLines = Math.max(1, Math.floor(current.settings.speakerMaxLinesPerRequest || 600));
    const maxPromptChars = Math.max(4000, Math.floor(current.settings.speakerMaxPromptChars || 60000));
    const context = speakerContext(current, start);
    const hardEnd = Math.min(current.sentences.length, start + maxLines);
    let end = hardEnd;
    let lines = [];
    while (end > start) {
      lines = current.sentences.slice(start, end).map((sentence, offset) => ({
        id: start + offset + 1,
        text: sentence.text
      }));
      // buildPrompt adds roughly 650 chars of fixed instructions. Keep a
      // conservative margin so background-side prompt construction stays
      // beneath maxPromptChars without loading speaker-core in the page.
      const estimatedPromptChars = 900 + JSON.stringify(context).length + JSON.stringify(lines).length;
      if (estimatedPromptChars <= maxPromptChars || end === start + 1) {
        return { start, end, lines, context, estimatedPromptChars };
      }
      const nextCount = Math.max(1, Math.floor((end - start) * 0.8));
      end = start + nextCount;
    }
    return { start, end: start, lines: [], context, estimatedPromptChars: 0 };
  }

  async function labelAllSpeakers(current) {
    if (!current.settings.multiVoice) return;
    const signal = current.prepareAbortController.signal;
    for (let start = 0; start < current.sentences.length;) {
      if (current !== session || current.stopFlag || signal.aborted) return;
      const batch = speakerBatch(current, start);
      if (batch.end <= start) throw new Error("Could not create a speaker-labeling batch.");
      for (let index = batch.start; index < batch.end; index += 1) {
        const trace = traceFor(current, index);
        trace.speakerStart = traceTime(trace);
        trace.speakerBatchStart = batch.start + 1;
        trace.speakerBatchEnd = batch.end;
      }
      try {
        current.speakerRequestCount = (current.speakerRequestCount || 0) + 1;
        const labels = await ProviderClient.labelSpeakers({
          lines: batch.lines,
          context: batch.context,
          signal
        });
        if (current !== session || current.stopFlag || signal.aborted) return;
        if (!Array.isArray(labels) || labels.length !== batch.lines.length) {
          throw new Error("Invalid speaker labels.");
        }
        applySpeakerLabels(current, batch.start, labels);
      } catch (error) {
        if (signal.aborted) return;
        const message = error?.message || String(error);
        applySpeakerLabels(
          current,
          batch.start,
          fallbackSpeakerLabels(current, batch.lines, batch.context),
          message
        );
        current.speakerFallbackBatchCount = (current.speakerFallbackBatchCount || 0) + 1;
        console.warn("Full-transcript speaker labeling batch failed; using bounded fallback.", error);
      }
      start = batch.end;
    }
  }

  async function renderWaveTTS(current, startIdx, endIdx, options = {}) {
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
          const trace = traceFor(current, index);
          trace.ttsStart = traceTime(trace);
          delete trace.ttsError;
          try {
            const result = await ProviderClient.synthesize({
              text: current.translations[index],
              voice: current.settings.voice,
              speaker: current.speakers[index] || "U",
              speed: current.settings.speed,
              signal: options.signal || current.abortController.signal
            });
            if (current !== session || current.stopFlag || options.signal?.aborted) return;
            current.sentences[index]._buffer = await AudioScheduler.decodeCompleteAudio(
              current.audioCtx, result.audio
            );
            trace.ttsEnd = traceTime(trace);
            const ttsDuration = trace.ttsEnd - trace.ttsStart;
            current.estimatedTtsSeconds = current.estimatedTtsSeconds == null
              ? ttsDuration : current.estimatedTtsSeconds * 0.75 + ttsDuration * 0.25;
            options.onReady?.(index);
          } catch (error) {
            trace.ttsError = error?.message || String(error);
            throw error;
          }
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

  function queueMultiVoiceAudio(current, start, end) {
    const signal = current.renderAbortController.signal;
    current.renderTail = current.renderTail.then(async () => {
      if (current !== session || current.stopFlag || signal.aborted) return;
      await renderWaveTTS(current, start, end, {
        signal,
        onReady(index) {
          if (current !== session || current.stopFlag || signal.aborted) return;
          if (current.waitingForAudio === index) {
            void current.video.play().catch(() => {});
          } else if (!current.video.paused) {
            recordScheduledAudio(current, scheduleWithTrace(current, index, index + 1));
            if (index === current.nextAudioIndex &&
                (current.scheduledSentenceIndexes.has(index) || current.playedSentenceIndexes.has(index))) {
              current.nextAudioIndex += 1;
            }
          }
        }
      });
    }).catch((error) => {
      if (current !== session || current.stopFlag || signal.aborted) return;
      const message = error?.message || String(error);
      stopSession("Dub render failed", false, false);
      setProbe("Dub render failed", message);
      emitState({ running: false, status: "Dub render failed", errorMessage: message });
    });
  }

  function maybeWaitForMultiVoiceAudio(current) {
    const now = current.video.currentTime;
    const index = current.nextAudioIndex;
    const sentence = current.sentences[index];
    if (!sentence || sentence.start > now + 0.5 || current.waitingForAudio != null) return;
    if (current.playedSentenceIndexes.has(index)) {
      current.nextAudioIndex += 1;
      return;
    }
    if (current.scheduledSentenceIndexes.has(index)) {
      current.nextAudioIndex += 1;
      return;
    }
    if (sentence._buffer) {
      recordScheduledAudio(current, scheduleWithTrace(current, index, index + 1));
      if (current.scheduledSentenceIndexes.has(index)) {
        current.nextAudioIndex += 1;
      } else if (sentence.start < now - AudioScheduler.LATE_CUE_THRESHOLD_SEC) {
        // The scheduler intentionally drops materially late cues. Waiting for
        // one can never succeed because it only becomes later while paused.
        current.nextAudioIndex += 1;
      } else {
        current.waitingForAudio = index;
        const trace = traceFor(current, index);
        trace.waitStart = traceTime(trace);
        current.video.pause();
      }
      return;
    }
    if (current.audioTimings.some((item) => !item.closed && !item.discarded &&
        item.start <= now && item.end > now)) return;
    current.waitingForAudio = index;
    const trace = traceFor(current, index);
    trace.waitStart = traceTime(trace);
    recordScheduleDecision(current, { index, status: "waiting", videoTime: now });
    current.video.pause();
  }

  async function runRollingRenderer(current) {
    while (current === session && !current.stopFlag) {
      await new Promise((resolve) => setTimeout(resolve, current.settings.multiVoice ? 250 : 1000));
      if (current !== session || current.stopFlag) return;
      // A scheduler-induced pause is not a user pause. Keep rendering while
      // waiting so the missing sentence can be translated and synthesized;
      // otherwise multi-voice can deadlock at the first uncached cue.
      if (current.paused && current.waitingForAudio == null) {
        updateLiveDisplay(current);
        continue;
      }

      if (current.settings.multiVoice && !current.video.paused) {
        maybeWaitForMultiVoiceAudio(current);
      }

      const videoTime = current.video.currentTime;
      const renderBatchSize = Math.max(1, Math.floor(
        current.settings.renderBatchSize ?? current.settings.speakerChunkSize ?? 8
      ));
      const multiLookahead = current.settings.multiVoice ? Math.min(
        current.settings.multiVoiceMaxLookaheadSeconds ?? 120,
        Math.max(current.settings.multiVoiceLookaheadSeconds ?? 60,
          (current.estimatedTtsSeconds || 0) * renderBatchSize)
      ) : 0;
      const horizon = videoTime + (current.settings.multiVoice
        ? multiLookahead : AudioScheduler.LOOKAHEAD_MS / 1000);
      let targetIdx = current.sentences.findIndex((sentence) => sentence.start > horizon);
      if (targetIdx === -1) targetIdx = current.sentences.length;
      if (current.settings.multiVoice) {
        targetIdx = Math.min(targetIdx, current.renderCursor + renderBatchSize);
      }
      if (targetIdx <= current.renderCursor) {
        updateLiveDisplay(current);
        continue;
      }

      const start = current.renderCursor;
      const end = targetIdx;
      const seekGeneration = current.seekGeneration;
      try {
        const firstUntranslated = current.translations.findIndex(
          (value, index) => index >= start && index < end && !value
        );
        if (firstUntranslated !== -1) {
          await translateBatch(current, firstUntranslated, end);
        }
        if (current !== session || current.stopFlag) return;
        if (seekGeneration !== current.seekGeneration) continue;
        if (current.settings.multiVoice) {
          queueMultiVoiceAudio(current, start, end);
        } else {
          await renderWaveTTS(current, start, end);
          if (current !== session || current.stopFlag) return;
          recordScheduledAudio(current, scheduleWithTrace(current, start, end));
        }
        current.renderCursor = end;
        updateLiveDisplay(current);
      } catch (error) {
        if (current !== session || current.stopFlag) return;
        if (seekGeneration !== current.seekGeneration) continue;
        const message = error?.message || String(error);
        stopSession("Dub render failed", false, false);
        setProbe("Dub render failed", message);
        emitState({ running: false, status: "Dub render failed", errorMessage: message });
        return;
      }
    }
  }

  function firstWaveBounds(sentences, currentTime) {
    // Include a caption that is already active at the playhead. onPlay uses
    // the same end>=playhead rule; preparing a different window here can make
    // nextAudioIndex point behind renderCursor to a cue that was never TTS'd.
    let start = sentences.findIndex((sentence) => sentence.end >= currentTime);
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
      prepareAbortController: new AbortController(),
      sentences: [],
      rawCaptions: [],
      translations: [],
      diagnostics: [],
      speakers: [],
      speakerRequestCount: 0,
      speakerFallbackBatchCount: 0,
      speakerMarkerLabels: new Map(),
      renderAbortController: new AbortController(),
      renderTail: Promise.resolve(),
      seekGeneration: 0,
      waitingForAudio: null,
      nextAudioIndex: 0,
      audioTimings: [],
      audioTimingBySource: new WeakMap(),
      pendingSources: [],
      scheduledSentenceIndexes: new Set(),
      playedSentenceIndexes: new Set(),
      audioOffset: 0,
      renderCursor: 0,
      stopFlag: false,
      paused: video.paused,
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
      setProbe(current.settings.multiVoice ? "Identifying speakers…" : "Translating first wave…");
      await Promise.all([
        translateBatch(current, firstWave.start, firstWave.end),
        labelAllSpeakers(current)
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
    recordScheduledAudio(current, scheduleWithTrace(current, firstWave.start, firstWave.end));
    current.renderCursor = firstWave.end;
    current.nextAudioIndex = firstWave.end;
    applyVolumes(current);

    const onPause = () => {
      if (current !== session || current.stopFlag) return;
      current.paused = true;
      if (current.waitingForAudio != null) {
        closeScheduledAudio(current);
        AudioScheduler.cancelPendingSources(current);
        if (current.sentences[current.waitingForAudio]?._buffer) {
          void current.video.play().catch(() => {});
        }
        return;
      }
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
      const waitingIndex = current.waitingForAudio;
      current.waitingForAudio = null;
      if (waitingIndex != null && !current.sentences[waitingIndex]?._buffer) {
        current.waitingForAudio = waitingIndex;
        current.video.pause();
        return;
      }
      if (waitingIndex != null) {
        const trace = traceFor(current, waitingIndex);
        trace.waitEnd = traceTime(trace);
        recordScheduledAudio(current, AudioScheduler.scheduleWindow(
          current, waitingIndex, waitingIndex + 1, {
            lateThresholdSec: Infinity,
            onDecision: (decision) => recordScheduleDecision(current, decision)
          }
        ));
      }
      const window = AudioScheduler.scheduleAroundPlayhead(current, current.video, {
        onDecision: (decision) => recordScheduleDecision(current, decision)
      });
      recordScheduledAudio(current, window.scheduled);
      if (current.settings.multiVoice) {
        current.nextAudioIndex = waitingIndex != null ? waitingIndex + 1 : window.start;
        while (current.scheduledSentenceIndexes.has(current.nextAudioIndex) ||
               current.playedSentenceIndexes.has(current.nextAudioIndex)) current.nextAudioIndex += 1;
      }
      if (!current.settings.multiVoice && window.start < current.renderCursor) {
        current.renderCursor = window.start;
      }
      updateLiveDisplay(current);
      emitState({ running: true, paused: false, status: "Translating", errorMessage: "" });
    };
    const onSeeked = () => {
      if (current !== session || current.stopFlag) return;
      const wasWaitingForAudio = current.waitingForAudio != null;
      discardPendingAudio(current);
      AudioScheduler.cancelPendingSources(current);
      current.playedSentenceIndexes.clear();
      if (current.settings.multiVoice) {
        current.seekGeneration += 1;
        current.prepareAbortController.abort();
        current.prepareAbortController = new AbortController();
        current.renderAbortController.abort();
        current.renderAbortController = new AbortController();
        current.renderTail = Promise.resolve();
        current.waitingForAudio = null;
      }
      current.audioOffset = AudioScheduler.computeAudioOffset(
        current.audioCtx.currentTime,
        current.video.currentTime
      );
      const window = AudioScheduler.scheduleAroundPlayhead(current, current.video, {
        onDecision: (decision) => recordScheduleDecision(current, decision)
      });
      recordScheduledAudio(current, window.scheduled);
      if (current.settings.multiVoice) {
        current.renderCursor = window.start;
        current.nextAudioIndex = window.start;
        while (current.scheduledSentenceIndexes.has(current.nextAudioIndex) ||
               current.playedSentenceIndexes.has(current.nextAudioIndex)) current.nextAudioIndex += 1;
      } else if (window.start < current.renderCursor) current.renderCursor = window.start;
      updateLiveDisplay(current);
      if (wasWaitingForAudio) void current.video.play().catch(() => {});
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
    const startupPaused = video.paused;
    current.paused = startupPaused;
    const startupStatus = startupPaused ? "Paused" : "Translating";
    setProbe(startupStatus);
    emitState({ running: true, paused: startupPaused, status: startupStatus, errorMessage: "" });
    void runRollingRenderer(current);
    return { ok: true, status: startupStatus, count: sentences.length };
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
      try { current.prepareAbortController.abort(); } catch {}
      try { current.renderAbortController.abort(); } catch {}
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
