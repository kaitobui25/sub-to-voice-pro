(function initSubToVoiceContent() {
  "use strict";

  if (globalThis.__SUB_TO_VOICE_CONTENT_LOADED__) return;
  globalThis.__SUB_TO_VOICE_CONTENT_LOADED__ = true;

  const CaptionCore = globalThis.SubToVoiceCaptionCore;
  if (!CaptionCore) throw new Error("Sub-to-Voice caption core did not load.");

  const YT_CC_BUTTON_SELECTORS = [
    "button.ytp-subtitles-button",
    ".ytp-chrome-controls .ytp-subtitles-button",
    'button[aria-label*="captions" i]',
    'button[aria-label*="subtitle" i]'
  ];

  let session = null;
  let lastUrl = location.href;

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

  async function fetchJson3(url, signal) {
    const target = url.includes("fmt=") ? url : url + "&fmt=json3";
    const response = await fetch(target, { credentials: "include", signal });
    if (!response.ok) return null;
    const json = await response.json().catch(() => null);
    const captions = CaptionCore.parseJson3Events(json?.events || []);
    return captions.length ? { captions, sourceUrl: target } : null;
  }

  async function fetchYouTubeCaptions(videoId, targetLanguage, signal) {
    try {
      const intercepted = await fetchCCViaIntercept(videoId, signal);
      if (intercepted?.url) {
        const result = await fetchJson3(intercepted.url, signal);
        if (result) {
          return {
            ...result,
            lang: intercepted.lang,
            kind: intercepted.kind,
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
        const result = await fetchJson3(picked.baseUrl, signal);
        if (result) {
          return {
            ...result,
            lang: picked.languageCode,
            kind: picked.kind || null,
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
    document.getElementById("stv-probe")?.remove();
  }

  function emitState(partial) {
    chrome.runtime.sendMessage({ type: "CONTENT_STATE", ...partial }).catch(() => {});
  }

  async function startCaptionSession() {
    stopCaptionSession("restart", false);
    const video = findVideo();
    if (!video) return { ok: false, error: "No video on this page." };

    const videoId = getYouTubeVideoId();
    if (!videoId) return { ok: false, error: "Could not detect YouTube video id." };

    const abortController = new AbortController();
    const current = {
      video,
      videoId,
      abortController,
      sentences: [],
      source: null
    };
    session = current;
    setProbe("Loading captions…");

    let result = null;
    try {
      result = await fetchYouTubeCaptions(videoId, "vi", abortController.signal);
    } catch {
      result = null;
    }

    if (session !== current || abortController.signal.aborted) {
      return { ok: false, error: "Cancelled." };
    }

    if (!result?.captions?.length) {
      session = null;
      const message = "This phase requires a YouTube caption track.";
      setProbe(message);
      emitState({ running: false, status: "No captions", errorMessage: message });
      return { ok: false, error: message };
    }

    const sentences = CaptionCore.regroupToSentences(result.captions);
    current.sentences = sentences;
    current.source = result.source;

    let forwardIndex = sentences.findIndex((sentence) => sentence.end >= video.currentTime);
    if (forwardIndex === -1) forwardIndex = sentences.length;
    const sample = sentences
      .slice(forwardIndex, forwardIndex + 3)
      .map((sentence) => sentence.start.toFixed(2) + "s  " + sentence.text)
      .join("\n");
    const status = "Captions ready: " + sentences.length + " sentences · " + result.source;
    setProbe(status, sample);
    emitState({ running: true, status, errorMessage: "" });
    return { ok: true, status, count: sentences.length, forwardIndex };
  }

  function stopCaptionSession(reason, remove) {
    const stopReason = reason || "Stopped";
    const shouldRemove = remove !== false;
    if (session?.abortController) {
      try {
        session.abortController.abort();
      } catch {
        // No-op.
      }
    }
    session = null;
    if (shouldRemove) removeProbe();
    if (stopReason !== "restart") {
      emitState({ running: false, status: stopReason, errorMessage: "" });
    }
  }

  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    if (session) stopCaptionSession("YouTube navigated.");
  }, 500);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      switch (message?.type) {
        case "CONTENT_PING":
          sendResponse({ ok: true, version: "0.1.0" });
          break;
        case "CONTENT_START":
          sendResponse(await startCaptionSession());
          break;
        case "CONTENT_STOP":
          stopCaptionSession();
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: "Unknown content message: " + message?.type });
      }
    })();
    return true;
  });
})();
