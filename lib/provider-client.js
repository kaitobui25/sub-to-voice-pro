(function initProviderClient(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SubToVoiceProviderClient = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function providerClientFactory() {
  "use strict";

  let requestSequence = 0;

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (reply) => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            reject(new Error(runtimeError.message || "Extension messaging failed."));
            return;
          }
          if (!reply?.ok) {
            const error = new Error(reply?.error || "Provider request failed.");
            error.telemetry = reply?.telemetry;
            error.attempts = reply?.attempts || [];
            reject(error);
            return;
          }
          resolve(reply);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes.buffer;
  }

  function createAbortError() {
    const error = new Error("Provider request aborted.");
    error.name = "AbortError";
    return error;
  }

  function sendCancelable(type, payload, signal) {
    if (signal?.aborted) return Promise.reject(createAbortError());
    const requestId = "stv-" + Date.now() + "-" + (++requestSequence);
    let settled = false;

    return new Promise((resolve, reject) => {
      const abort = () => {
        if (settled) return;
        settled = true;
        try {
          const cancellation = chrome.runtime.sendMessage({
            type: "CANCEL_PROVIDER_REQUEST",
            requestId
          });
          if (cancellation && typeof cancellation.catch === "function") {
            cancellation.catch(() => {});
          }
        } catch {
          // The session is already stopping; cancellation is best effort here.
        }
        reject(createAbortError());
      };
      signal?.addEventListener("abort", abort, { once: true });

      sendMessage({ type, requestId, ...payload }).then(
        (reply) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", abort);
          resolve(reply);
        },
        (error) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", abort);
          reject(error);
        }
      );
    });
  }

  async function getRuntimeSettings() {
    const reply = await sendMessage({ type: "GET_RUNTIME_SETTINGS" });
    return reply.settings;
  }

  async function translateBatch(request) {
    const reply = await sendCancelable("TRANSLATE_BATCH", {
      lines: request.lines,
      sourceLanguage: request.sourceLanguage,
      targetLanguage: request.targetLanguage,
      context: request.context || []
    }, request.signal);
    request.onAttempt && (reply.attempts || []).forEach(request.onAttempt);
    return reply.lines;
  }

  async function synthesize(request) {
    const now = () => globalThis.performance?.now?.() ?? Date.now();
    const started = now();
    const reply = await sendCancelable("SYNTHESIZE", {
      text: request.text,
      voice: request.voice,
      speaker: request.speaker,
      speed: request.speed
    }, request.signal);
    const received = now();
    const audio = base64ToArrayBuffer(reply.audioBase64);
    return {
      audio,
      mimeType: reply.mimeType,
      telemetry: { ...reply.telemetry, roundTripMs: received - started, base64DecodeMs: now() - received }
    };
  }

  async function labelSpeakers(request) {
    const reply = await sendCancelable("LABEL_SPEAKERS", {
      lines: request.lines,
      context: request.context
    }, request.signal);
    return reply.labels;
  }

  return {
    getRuntimeSettings,
    translateBatch,
    labelSpeakers,
    synthesize
  };
});
