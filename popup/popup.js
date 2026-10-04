"use strict";

const enabled = document.getElementById("enabled");
const volume = document.getElementById("original-volume");
const volumeValue = document.getElementById("volume-value");
const status = document.getElementById("status");
const downloadTranscript = document.getElementById("download-transcript");
const downloadDiagnostics = document.getElementById("download-diagnostics");
const translationProvider = document.getElementById("translation-provider");
const ttsProvider = document.getElementById("tts-provider");
const voiceMode = document.getElementById("voice-mode");
const speakerPanel = document.getElementById("speaker-panel");
const speakerList = document.getElementById("speaker-list");
let tabId = null;
let volumeTimer = null;
let pendingVolume = Promise.resolve();

async function request(message) {
  const reply = await chrome.runtime.sendMessage(message);
  if (!reply?.ok) throw new Error(reply?.error || "Không thể kết nối extension.");
  return reply;
}

function showError(error) {
  status.textContent = error?.message || String(error);
}

function renderSpeakers(state) {
  speakerPanel.hidden = state.voiceMode !== "multi";
  if (speakerPanel.hidden) return;
  const speakers = Array.isArray(state.speakers) ? state.speakers : [];
  speakerList.textContent = speakers.length
    ? speakers.map(({ label, voice }) => `${label}${voice ? ` — ${voice}` : ""}`).join("\n")
    : "Chưa nhận diện người nói.";
}

async function initialize() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id;
    const state = await request({ type: "GET_POPUP_STATE", tabId });
    enabled.checked = Boolean(state.enabled);
    enabled.disabled = !state.canStart && !state.enabled;
    status.textContent = state.error || (state.canStart ? state.status : "Mở một video YouTube để bật.");
    volume.value = state.originalVolume;
    volumeValue.value = state.originalVolume + "%";
    volume.disabled = false;
    downloadTranscript.disabled = !state.canStart;
    downloadDiagnostics.disabled = !state.canStart;
    translationProvider.value = state.translationSelection || "google";
    ttsProvider.value = state.ttsSelection || "vieneu";
    translationProvider.disabled = false;
    ttsProvider.disabled = false;
    voiceMode.value = state.voiceMode || "single";
    voiceMode.disabled = false;
    renderSpeakers(state);
  } catch (error) {
    showError(error);
  }
}

async function refreshStatus() {
  if (tabId == null || enabled.disabled) return;
  try {
    const state = await request({ type: "GET_POPUP_STATE", tabId });
    enabled.checked = Boolean(state.enabled);
    status.textContent = state.error || state.status;
    voiceMode.value = state.voiceMode || "single";
    renderSpeakers(state);
  } catch (error) {
    showError(error);
  }
}

enabled.addEventListener("change", async () => {
  const requested = enabled.checked;
  enabled.disabled = true;
  status.textContent = requested ? "Đang bật…" : "Đang tắt…";
  try {
    if (volumeTimer) {
      clearTimeout(volumeTimer);
      volumeTimer = null;
      saveVolume();
    }
    await pendingVolume;
    const result = await request({ type: "SET_ENABLED", tabId, enabled: requested });
    enabled.checked = Boolean(result.enabled);
    status.textContent = result.status;
  } catch (error) {
    enabled.checked = !requested;
    showError(error);
  } finally {
    enabled.disabled = false;
  }
});

function saveVolume() {
  const selected = Number(volume.value);
  pendingVolume = pendingVolume.then(() => request({
    type: "SET_ORIGINAL_VOLUME", volume: selected
  })).catch(showError);
  return pendingVolume;
}

volume.addEventListener("input", () => {
  volumeValue.value = volume.value + "%";
  clearTimeout(volumeTimer);
  volumeTimer = setTimeout(saveVolume, 100);
});
volume.addEventListener("change", () => {
  clearTimeout(volumeTimer);
  void saveVolume();
});

for (const [element, kind] of [[translationProvider, "translation"], [ttsProvider, "tts"]]) {
  element.addEventListener("change", async () => {
    element.disabled = true;
    try {
      await request({ type: "SET_PROVIDER_SELECTION", kind, value: element.value });
      await refreshStatus();
    } catch (error) {
      showError(error);
      await initialize();
    } finally {
      element.disabled = false;
    }
  });
}

voiceMode.addEventListener("change", async () => {
  voiceMode.disabled = true;
  try {
    await request({ type: "SET_VOICE_MODE", value: voiceMode.value });
    await refreshStatus();
  } catch (error) {
    showError(error);
    await initialize();
  } finally {
    voiceMode.disabled = false;
  }
});

function downloadFile(content, filename, type, bom = false) {
  const url = URL.createObjectURL(new Blob(bom ? ["\uFEFF", content] : [content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  try { link.click(); } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

downloadDiagnostics.addEventListener("click", async () => {
  downloadDiagnostics.disabled = true;
  try {
    const { log } = await request({ type: "GET_DIAGNOSTIC_LOG", tabId });
    if (!log) throw new Error("Chưa có log. Hãy bật dịch và đọc voice trước.");
    downloadFile(JSON.stringify(log, null, 2), `sub-to-voice-${log.videoId || "session"}-diagnostics.json`, "application/json;charset=utf-8");
  } catch (error) {
    showError(error);
  } finally {
    downloadDiagnostics.disabled = false;
  }
});

downloadTranscript.addEventListener("click", async () => {
  downloadTranscript.disabled = true;
  try {
    const reply = await request({ type: "GET_TRANSCRIPT", tabId });
    const transcript = reply.transcript;
    if (!transcript?.rows?.length) throw new Error("Chưa có phụ đề để tải.");
    const content = SubToVoiceTranscriptExport.format(transcript);
    downloadFile(content, `sub-to-voice-${transcript.videoId || "transcript"}.txt`, "text/plain;charset=utf-8", true);
  } catch (error) {
    showError(error);
  } finally {
    downloadTranscript.disabled = false;
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "CONTENT_STATE") void refreshStatus();
});

void initialize();
