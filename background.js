"use strict";

importScripts(
  "lib/translation-core.js",
  "lib/tts-core.js",
  "lib/speaker-core.js",
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
  errorMessage: "",
  detectedSpeakers: []
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

function validVolume(value) {
  return Number.isInteger(value) && value >= 0 && value <= 100;
}

async function originalVolumeSetting(config) {
  const saved = await chrome.storage.local.get("originalVolume");
  return validVolume(saved.originalVolume)
    ? saved.originalVolume : config.audio?.originalVolume ?? 18;
}

async function providerSelections(config) {
  const saved = await chrome.storage.local.get(["translationSelection", "ttsSelection", "voiceMode"]);
  return { ...SubToVoiceProviderRuntime.resolveSelections(config, saved),
    voiceMode: saved.voiceMode === "multi" ? "multi" : "single" };
}

function publicRuntimeSettings(config, selections) {
  const profile = SubToVoiceProviderRuntime.ttsProfile(config.tts, selections.tts);
  return {
    sourceLanguage: config.translation?.sourceLanguage || "auto",
    targetLanguage: config.translation?.targetLanguage || "vi",
    originalVolume: config.audio?.originalVolume ?? 18,
    voiceVolume: config.audio?.voiceVolume ?? 100,
    ttsProvider: selections.tts,
    translationProvider: selections.translation,
    multiVoice: selections.voiceMode === "multi" && Array.isArray(profile?.speakerVoices) && profile.speakerVoices.length > 1,
    speakerVoiceCount: Array.isArray(profile?.speakerVoices) ? profile.speakerVoices.length : 0,
    renderBatchSize: config.speakerDetection?.renderBatchSize ?? config.speakerDetection?.chunkSize ?? 8,
    speakerMaxLinesPerRequest: config.speakerDetection?.maxLinesPerRequest ?? 300,
    speakerMaxPromptChars: config.speakerDetection?.maxPromptChars ?? 60000,
    speakerContextSize: config.speakerDetection?.contextSize ?? 8,
    multiVoiceLookaheadSeconds: config.speakerDetection?.lookaheadSeconds ?? 60,
    multiVoiceMaxLookaheadSeconds: config.speakerDetection?.maxLookaheadSeconds ?? 120,
    playbackSync: config.playbackSync || {},
    audioPreparation: config.audioPreparation || {},
    voice: profile?.voice || null,
    speed: config.tts?.speed ?? 1,
    ttsConcurrency: Math.max(1, Math.floor(profile?.maxConcurrency ?? 5))
  };
}

async function translateWithConfiguredProvider(message, signal) {
  const config = await loadRuntimeConfig();
  const translation = config.translation || {};
  const selection = (await providerSelections(config)).translation;
  const manager = SubToVoiceProviderRuntime.createTranslationManager(
    SubToVoiceProviderRuntime.translationConfig(translation, selection)
  );
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
  const selections = await providerSelections(config);
  const selection = selections.tts;
  return SubToVoiceProviderRuntime.synthesizeWithSelection(tts, selection, {
    text: message.text, speed: message.speed ?? tts.speed ?? 1,
    speaker: message.speaker, multiVoice: selections.voiceMode === "multi", signal
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
      ? "Sub-to-Voice Pro: đang bật"
      : "Sub-to-Voice Pro: đang tắt";
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

function contentScriptBundle() {
  const bundle = chrome.runtime.getManifest()?.content_scripts?.[0];
  if (!bundle?.js?.length) throw new Error("Manifest content script bundle is missing.");
  return {
    js: [...bundle.js],
    css: Array.isArray(bundle.css) ? [...bundle.css] : []
  };
}

async function ensureContentScript(tabId) {
  try {
    const reply = await chrome.tabs.sendMessage(tabId, { type: "CONTENT_PING" });
    if (reply?.ok) return;
  } catch {
    // The target tab may predate extension installation/reload.
  }

  const bundle = contentScriptBundle();
  await chrome.scripting.executeScript({
    target: { tabId },
    files: bundle.js
  });
  if (bundle.css.length) {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: bundle.css
    }).catch(() => {});
  }
}

async function stopActiveSession(reason) {
  stateGeneration += 1;
  const tabId = state.tabId;
  state = {
    running: false,
    starting: false,
    tabId: null,
    status: reason || "Stopped",
    errorMessage: "",
    detectedSpeakers: []
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
    errorMessage: "",
    detectedSpeakers: []
  };
  await setActionState("loading", false);
  const config = await loadRuntimeConfig();
  const selection = (await providerSelections(config)).tts;
  await SubToVoiceProviderRuntime.ensureInitialTTSReady(config.tts, selection);
  if (generation !== stateGeneration) return { ok: false, cancelled: true };
  await ensureContentScript(tab.id);
  if (generation !== stateGeneration) return { ok: false, cancelled: true };

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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.tab && message?.type === "GET_YT_CC_URL") {
    const entry = message.videoId ? ytCaptionCache.get(message.videoId) : null;
    sendResponse({ ok: Boolean(entry), ...(entry || {}) });
    return false;
  }

  if (sender.tab && message?.type === "CONTENT_STATE") {
    if (sender.tab.id === state.tabId) {
      if (Array.isArray(message.detectedSpeakers)) {
        state.detectedSpeakers = message.detectedSpeakers.filter((label) =>
          typeof label === "string" && /^S[1-9]\d*$/.test(label));
      }
      if (typeof message.running === "boolean") {
        state.running = message.running;
        state.starting = false;
        state.status = message.status || state.status;
        state.errorMessage = message.errorMessage || "";
        void setActionState(state.running ? "running" : "idle", Boolean(state.errorMessage));
      }
    }
    sendResponse({ ok: true });
    return false;
  }

  if (sender.tab && message?.type === "GET_RUNTIME_SETTINGS") {
    (async () => {
      const config = await loadRuntimeConfig();
      const settings = publicRuntimeSettings(config, await providerSelections(config));
      settings.originalVolume = await originalVolumeSetting(config);
      sendResponse({ ok: true, settings });
    })().catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
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

  if (sender.tab && message?.type === "LABEL_SPEAKERS") {
    const requestId = String(message.requestId || "");
    const controller = new AbortController();
    let timeoutId = null;
    let timedOut = false;
    if (requestId) providerRequestControllers.set(requestId, controller);
    (async () => {
      const config = await loadRuntimeConfig();
      if ((await providerSelections(config)).voiceMode !== "multi") {
        throw new Error("Multi-voice mode is off.");
      }
      if (!Array.isArray(message.lines) || !message.lines.length ||
          message.lines.length > (config.speakerDetection?.maxLinesPerRequest ?? 300)) {
        throw new Error("Invalid speaker batch size.");
      }
      const timeoutMs = Math.max(1000, Number(config.speakerDetection?.timeoutMs || 25000));
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      return SubToVoiceProviderRuntime.labelSpeakers(
        config.translation, config.speakerDetection || {},
        message.lines, message.context || [], controller.signal
      );
    })().then(
      (labels) => sendResponse({ ok: true, labels }),
      (error) => sendResponse({
        ok: false,
        error: timedOut ? "Speaker labeling timed out." : (error?.message || String(error))
      })
    ).finally(() => {
      if (timeoutId != null) clearTimeout(timeoutId);
      if (requestId) providerRequestControllers.delete(requestId);
    });
    return true;
  }

  if (sender.tab && message?.type === "SYNTHESIZE") {
    const requestId = String(message.requestId || "");
    const controller = new AbortController();
    if (requestId) providerRequestControllers.set(requestId, controller);
    synthesizeWithConfiguredProvider(message, controller.signal).then(
      (result) => {
        const started = performance.now();
        const audioBase64 = arrayBufferToBase64(result.audio);
        sendResponse({
        ok: true,
        audioBase64,
        mimeType: result.mimeType,
        telemetry: { ...result.telemetry, base64EncodeMs: performance.now() - started }
      });
      },
      (error) => sendResponse({ ok: false, error: error?.message || String(error), telemetry: error?.telemetry })
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

  if (!sender.tab && message?.type === "GET_POPUP_STATE") {
    (async () => {
      const config = await loadRuntimeConfig();
      const selections = await providerSelections(config);
      const profile = SubToVoiceProviderRuntime.ttsProfile(config.tts, selections.tts);
      const tabId = Number(message.tabId);
      const tab = Number.isInteger(tabId) ? await chrome.tabs.get(tabId) : null;
      sendResponse({
        ok: true,
        enabled: state.tabId === tabId && (state.running || state.starting),
        canStart: isYouTubeWatchUrl(tab?.url),
        status: state.tabId === tabId ? state.status : "Ready",
        error: state.tabId === tabId ? state.errorMessage : "",
        originalVolume: await originalVolumeSetting(config),
        translationSelection: selections.translation,
        ttsSelection: selections.tts,
        voiceMode: selections.voiceMode,
        speakers: selections.voiceMode === "multi" && Array.isArray(profile?.speakerVoices) && state.tabId === tabId
          ? state.detectedSpeakers.map((label) => ({
            label,
            voice: SubToVoiceSpeakerCore.voiceForSpeaker(label, profile?.speakerVoices, profile?.voice) || ""
          })) : []
      });
    })().catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (!sender.tab && message?.type === "SET_VOICE_MODE") {
    (async () => {
      if (!["single", "multi"].includes(message.value)) throw new Error("Invalid voice mode.");
      await chrome.storage.local.set({ voiceMode: message.value });
      if (state.tabId && (state.running || state.starting)) {
        const tab = await chrome.tabs.get(state.tabId);
        await stopActiveSession("Changing voice mode");
        await startInTab(tab);
      }
      sendResponse({ ok: true, voiceMode: message.value });
    })().catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (!sender.tab && message?.type === "SET_PROVIDER_SELECTION") {
    (async () => {
      const key = message.kind === "translation" ? "translationSelection"
        : message.kind === "tts" ? "ttsSelection" : null;
      if (!key || !SubToVoiceProviderRuntime.validSelection(message.kind, message.value)) {
        throw new Error("Invalid provider selection.");
      }
      await chrome.storage.local.set({ [key]: message.value });
      if (state.tabId && (state.running || state.starting)) {
        const tab = await chrome.tabs.get(state.tabId);
        await stopActiveSession("Changing provider");
        await startInTab(tab);
      }
      sendResponse({ ok: true, value: message.value });
    })().catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (!sender.tab && ["GET_TRANSCRIPT", "GET_DIAGNOSTIC_LOG"].includes(message?.type)) {
    (async () => {
      const tabId = Number(message.tabId);
      if (!Number.isInteger(tabId)) throw new Error("Open a YouTube video first.");
      const tab = await chrome.tabs.get(tabId);
      if (!isYouTubeWatchUrl(tab?.url)) throw new Error("Open a YouTube video first.");
      const reply = await chrome.tabs.sendMessage(tabId, { type: message.type === "GET_DIAGNOSTIC_LOG" ? "CONTENT_GET_DIAGNOSTIC_LOG" : "CONTENT_GET_TRANSCRIPT" });
      sendResponse(reply?.ok ? reply : { ok: false, error: reply?.error || "No transcript is available yet." });
    })().catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (!sender.tab && message?.type === "SET_ENABLED") {
    (async () => {
      const tabId = Number(message.tabId);
      if (!Number.isInteger(tabId)) throw new Error("No active tab selected.");
      if (message.enabled) {
        if (!(state.tabId === tabId && (state.running || state.starting))) {
          const tab = await chrome.tabs.get(tabId);
          await startInTab(tab);
        }
      } else if (state.tabId === tabId && (state.running || state.starting)) {
        await stopActiveSession();
      }
      sendResponse({ ok: true, enabled: state.tabId === tabId && (state.running || state.starting), status: state.status });
    })().catch(async (error) => {
      const errorMessage = error?.message || String(error);
      if (state.tabId === Number(message.tabId)) {
        state.running = false;
        state.starting = false;
        state.status = "Error";
        state.errorMessage = errorMessage;
        await setActionState("idle", true);
      }
      sendResponse({ ok: false, error: errorMessage });
    });
    return true;
  }

  if (!sender.tab && message?.type === "SET_ORIGINAL_VOLUME") {
    (async () => {
      if (!validVolume(message.volume)) throw new Error("Volume must be between 0 and 100.");
      await chrome.storage.local.set({ originalVolume: message.volume });
      if (state.tabId && (state.running || state.starting)) {
        await chrome.tabs.sendMessage(state.tabId, {
          type: "CONTENT_SET_ORIGINAL_VOLUME", volume: message.volume
        }).catch(() => {});
      }
      sendResponse({ ok: true, originalVolume: message.volume });
    })().catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
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
