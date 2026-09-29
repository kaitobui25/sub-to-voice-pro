"use strict";

const ytCaptionCache = new Map();
const YT_CACHE_TTL_MS = 30 * 60 * 1000;
const YT_CACHE_GC_MS = 5 * 60 * 1000;

let state = {
  running: false,
  tabId: null,
  status: "Ready",
  errorMessage: ""
};

function snapshot() {
  return { ...state };
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
    : state.running
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
    files: ["lib/caption-core.js", "content.js"]
  });
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ["content.css"]
  }).catch(() => {});
}

async function stopActiveSession(reason) {
  const tabId = state.tabId;
  state = {
    running: false,
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

  if (state.running && state.tabId && state.tabId !== tab.id) {
    await stopActiveSession("Switched tab");
  }

  state = {
    running: false,
    tabId: tab.id,
    status: "Loading captions",
    errorMessage: ""
  };
  await setActionState("loading", false);
  await ensureContentScript(tab.id);

  const reply = await chrome.tabs.sendMessage(tab.id, { type: "CONTENT_START" });
  if (!reply?.ok) {
    throw new Error(reply?.error || "Could not start caption session.");
  }

  state.running = true;
  state.status = reply.status || "Captions ready";
  await setActionState("running", false);
  return reply;
}

chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (state.running && state.tabId === tab.id) {
      await stopActiveSession();
      return;
    }
    await startInTab(tab);
  } catch (error) {
    state.running = false;
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
      state.status = message.status || state.status;
      state.errorMessage = message.errorMessage || "";
      void setActionState(state.running ? "running" : "idle", Boolean(state.errorMessage));
    }
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
