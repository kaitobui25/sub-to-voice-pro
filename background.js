"use strict";

importScripts(
  "lib/translation-core.js",
  "lib/tts-core.js",
  "lib/providers/runtime.js"
);

const ytCaptionCache = new Map();
const YT_CACHE_TTL_MS = 30 * 60 * 1000;
const YT_CACHE_GC_MS = 5 * 60 * 1000;
const providerRequestControllers = new Map();
let runtimeConfigPromise = null;

let state = {
  running: false,
  starting: false,
  tabId: null,
  status: "Ready",
  errorMessage: ""
};
let stateGeneration = 0;

function snapshot() {
  return { ...state };
}

async function loadRuntimeConfig() {
  if (!runtimeConfigPromise) {
    runtimeConfigPromise = fetch(chrome.runtime.getURL("runtime-config.local.json"))
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(
            "Missing runtime-config.local.json. Run: node scripts/generate-runtime-config.mjs"
          );
        }
        return response.json();
      })
      .catch((error) => {
        runtimeConfigPromise = null;
        throw error;
      });
  }
  return runtimeConfigPromise;
}

function publicRuntimeSettings(config) {
  return {
    sourceLanguage: config.translation?.sourceLanguage || "auto",
    targetLanguage: config.translation?.targetLanguage || "vi",
    originalVolume: config.audio?.originalVolume ?? 18,
    voiceVolume: config.audio?.voiceVolume ?? 100,
    voice: config.tts?.voice || null,
    speed: config.tts?.speed ?? 1
  };
}

async function translateWithConfiguredProvider(message, signal) {
  const config = await loadRuntimeConfig();
  const translation = config.translation || {};
  const manager = SubToVoiceProviderRuntime.createTranslationManager(translation);
  return manager.translateBatch({
    lines: message.lines,
    sourceLanguage: message.sourceLanguage || translation.sourceLanguage || "auto",
    targetLanguage: message.targetLanguage || translation.targetLanguage || "vi",
    signal
  });
}

async function synthesizeWithConfiguredProvider(message, signal) {
  const config = await loadRuntimeConfig();
  const tts = config.tts || {};
  const manager = SubToVoiceProviderRuntime.createTTSManager(tts);
  return manager.synthesize({
    text: message.text,
    voice: message.voice || tts.voice,
    speed: message.speed ?? tts.speed ?? 1,
    signal
  });
}

function arrayBufferToBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function isYouTubeWatchUrl(url) {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return /(^|\.)youtube\.com$/.test(parsed.hostname) &&
      (parsed.pathname === "/watch" || parsed.pathname.startsWith("/embed/"));
  } catch {
    return false;
  }
}

async function setActionState(status, failed) {
  const badgeText = failed ? "!" : status === "running" ? "ON" : status === "loading" ? "…" : "";
  await chrome.action.setBadgeText({ text: badgeText }).catch(() => {});
  const title = failed
    ? "Sub-to-Voice: " + (state.errorMessage || "Error")
    : (state.running || state.starting)
      ? "Stop Sub-to-Voice"
      : "Start Sub-to-Voice";
  await chrome.action.setTitle({ title }).catch(() => {});
}

if (typeof chrome.webRequest?.onCompleted?.addListener === "function") {
  chrome.webRequest.onCompleted.addListener(
    (details) => {
      try {
        if (details.statusCode !== 200) return;
        const url = new URL(details.url);
        const videoId = url.searchParams.get("v");
        if (!videoId) return;
        const isAsr = url.searchParams.get("kind") === "asr";
        const existing = ytCaptionCache.get(videoId);
        if (existing && !existing.isAsr && isAsr) return;
        ytCaptionCache.set(videoId, {
          url: details.url,
          lang: url.searchParams.get("lang") || null,
          kind: url.searchParams.get("kind") || null,
          tlang: url.searchParams.get("tlang") || null,
          isAsr,
          capturedAt: Date.now()
        });
      } catch {
        // Ignore malformed or unexpected timedtext requests.
      }
    },
    {
      urls: [
        "*://*.youtube.com/api/timedtext*",
        "*://*.youtube-nocookie.com/api/timedtext*"
      ]
    }
  );

  setInterval(() => {
    const cutoff = Date.now() - YT_CACHE_TTL_MS;
    for (const [videoId, entry] of ytCaptionCache) {
      if (entry.capturedAt < cutoff) ytCaptionCache.delete(videoId);
    }
  }, YT_CACHE_GC_MS);
}

async function ensureContentScript(tabId) {
  try {
    const reply = await chrome.tabs.sendMessage(tabId, { type: "CONTENT_PING" });
    if (reply?.ok) return;
  } catch {
    // The target tab may predate extension installation/reload.
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: [
      "lib/caption-core.js",
      "lib/audio-scheduler.js",
      "lib/provider-client.js",
      "content.js"
    ]
  });
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ["content.css"]
  }).catch(() => {});
}

async function stopActiveSession(reason) {
  stateGeneration += 1;
  const tabId = state.tabId;
  state = {
    running: false,
    starting: false,
    tabId: null,
    status: reason || "Stopped",
    errorMessage: ""
  };
  if (tabId) {
    await chrome.tabs.sendMessage(tabId, { type: "CONTENT_STOP" }).catch(() => {});
  }
  await setActionState("idle", false);
}

async function startInTab(tab) {
  if (!tab?.id || !isYouTubeWatchUrl(tab.url)) {
    throw new Error("Open a normal YouTube video first.");
  }

  if ((state.running || state.starting) && state.tabId && state.tabId !== tab.id) {
    await stopActiveSession("Switched tab");
  }

  const generation = ++stateGeneration;
  state = {
    running: false,
    starting: true,
    tabId: tab.id,
    status: "Loading captions",
    errorMessage: ""
  };
  await setActionState("loading", false);
  await ensureContentScript(tab.id);

  const reply = await chrome.tabs.sendMessage(tab.id, { type: "CONTENT_START" });
  if (generation !== stateGeneration) {
    return { ok: false, cancelled: true };
  }
  if (!reply?.ok) {
    throw new Error(reply?.error || "Could not start caption session.");
  }

  state.running = true;
  state.starting = false;
  state.status = reply.status || "Captions ready";
  await setActionState("running", false);
  return reply;
}

chrome.action.onClicked.addListener(async (tab) => {
  try {
    if ((state.running || state.starting) && state.tabId === tab.id) {
      await stopActiveSession();
      return;
    }
    const reply = await startInTab(tab);
    if (reply?.cancelled) return;
  } catch (error) {
    state.running = false;
    state.starting = false;
    state.status = "Error";
    state.errorMessage = error?.message || String(error);
    await setActionState("idle", true);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.tab && message?.type === "GET_YT_CC_URL") {
    const entry = message.videoId ? ytCaptionCache.get(message.videoId) : null;
    sendResponse({ ok: Boolean(entry), ...(entry || {}) });
    return false;
  }

  if (sender.tab && message?.type === "CONTENT_STATE") {
    if (sender.tab.id === state.tabId) {
      state.running = Boolean(message.running);
      state.starting = false;
      state.status = message.status || state.status;
      state.errorMessage = message.errorMessage || "";
      void setActionState(state.running ? "running" : "idle", Boolean(state.errorMessage));
    }
    sendResponse({ ok: true });
    return false;
  }

  if (sender.tab && message?.type === "GET_RUNTIME_SETTINGS") {
    loadRuntimeConfig().then(
      (config) => sendResponse({ ok: true, settings: publicRuntimeSettings(config) }),
      (error) => sendResponse({ ok: false, error: error?.message || String(error) })
    );
    return true;
  }

  if (sender.tab && message?.type === "TRANSLATE_BATCH") {
    const requestId = String(message.requestId || "");
    const controller = new AbortController();
    if (requestId) providerRequestControllers.set(requestId, controller);
    translateWithConfiguredProvider(message, controller.signal).then(
      (lines) => sendResponse({ ok: true, lines }),
      (error) => sendResponse({ ok: false, error: error?.message || String(error) })
    ).finally(() => {
      if (requestId) providerRequestControllers.delete(requestId);
    });
    return true;
  }

  if (sender.tab && message?.type === "SYNTHESIZE") {
    const requestId = String(message.requestId || "");
    const controller = new AbortController();
    if (requestId) providerRequestControllers.set(requestId, controller);
    synthesizeWithConfiguredProvider(message, controller.signal).then(
      (result) => sendResponse({
        ok: true,
        audioBase64: arrayBufferToBase64(result.audio),
        mimeType: result.mimeType
      }),
      (error) => sendResponse({ ok: false, error: error?.message || String(error) })
    ).finally(() => {
      if (requestId) providerRequestControllers.delete(requestId);
    });
    return true;
  }

  if (sender.tab && message?.type === "CANCEL_PROVIDER_REQUEST") {
    const requestId = String(message.requestId || "");
    const controller = providerRequestControllers.get(requestId);
    if (controller) controller.abort();
    providerRequestControllers.delete(requestId);
    sendResponse({ ok: true });
    return false;
  }

  if (!sender.tab && message?.type === "GET_STATE") {
    sendResponse({ ok: true, state: snapshot() });
    return false;
  }

  if (!sender.tab && message?.type === "STOP") {
    stopActiveSession().then(
      () => sendResponse({ ok: true, state: snapshot() }),
      (error) => sendResponse({ ok: false, error: error?.message || String(error) })
    );
    return true;
  }

  return false;
});
