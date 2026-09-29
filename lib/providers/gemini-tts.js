(function initGeminiTTSProvider(root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SubToVoiceGeminiTTS = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function geminiTTSProviderFactory(root) {
  "use strict";

  const modelCooldownUntil = new Map();

  function requireConfigString(value, name) {
    if (typeof value !== "string" || !value.trim()) {
      throw new TypeError(name + " must be a non-empty string.");
    }
    return value.trim();
  }

  function normalizeBaseUrl(value) {
    return requireConfigString(value, "baseUrl").replace(/\/+$/, "");
  }

  function normalizeModel(value) {
    return requireConfigString(value, "model").replace(/^models\//, "");
  }

  function normalizeModels(values, legacyModel) {
    const source = Array.isArray(values) && values.length ? values : [legacyModel];
    const models = source.filter(Boolean).map(normalizeModel);
    if (!models.length) throw new TypeError("models must contain at least one model.");
    return [...new Set(models)];
  }

  function redactSecret(text, secret) {
    const value = String(text || "");
    return secret ? value.split(secret).join("[redacted]") : value;
  }

  function parseRetryAfterMs(response, detail) {
    const header = response?.headers?.get?.("retry-after");
    if (header) {
      const seconds = Number(header);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.max(1000, Math.ceil(seconds * 1000));
      }
      const dateMs = Date.parse(header);
      if (Number.isFinite(dateMs)) {
        return Math.max(1000, dateMs - Date.now());
      }
    }

    const match = String(detail || "").match(
      /(?:retry\s+(?:in|after)|try\s+again\s+in)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|seconds?|m|min|minutes?)/i
    );
    if (!match) return 60000;
    const value = Number(match[1]);
    const unit = match[2].toLowerCase();
    if (unit.startsWith("ms")) return Math.max(1000, Math.ceil(value));
    if (unit.startsWith("m") && !unit.startsWith("ms")) {
      return Math.max(1000, Math.ceil(value * 60000));
    }
    return Math.max(1000, Math.ceil(value * 1000));
  }

  function cooldownKey(baseUrl, model) {
    return baseUrl + "|" + model;
  }

  function getRemainingCooldownMs(baseUrl, model, nowMs) {
    const until = modelCooldownUntil.get(cooldownKey(baseUrl, model)) || 0;
    if (until <= nowMs) {
      modelCooldownUntil.delete(cooldownKey(baseUrl, model));
      return 0;
    }
    return until - nowMs;
  }

  function setModelCooldown(baseUrl, model, retryAfterMs, nowMs) {
    modelCooldownUntil.set(
      cooldownKey(baseUrl, model),
      nowMs + Math.max(1000, retryAfterMs)
    );
  }

  function createAbortError() {
    const error = new Error("Gemini TTS request aborted.");
    error.name = "AbortError";
    return error;
  }

  function decodeBase64(base64) {
    if (root && typeof root.atob === "function") {
      const binary = root.atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return bytes.buffer;
    }
    if (typeof Buffer !== "undefined") {
      const bytes = Buffer.from(base64, "base64");
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    throw new Error("Base64 decoder unavailable.");
  }

  function findAudioBlock(payload) {
    if (payload?.output_audio?.data) return payload.output_audio;
    const blocks = [];
    for (const step of Array.isArray(payload?.steps) ? payload.steps : []) {
      for (const content of Array.isArray(step?.content) ? step.content : []) {
        if (content?.type === "audio" && typeof content.data === "string" && content.data) {
          blocks.push(content);
        }
      }
    }
    return blocks.length ? blocks[blocks.length - 1] : null;
  }

  async function readErrorBody(response, apiKey) {
    try {
      const text = await response.text();
      if (!text) return "";
      try {
        const parsed = JSON.parse(text);
        return redactSecret(parsed?.error?.message || parsed?.message || text, apiKey).slice(0, 500);
      } catch {
        return redactSecret(text, apiKey).slice(0, 500);
      }
    } catch {
      return "";
    }
  }

  function createGeminiTTSProvider(options) {
    const opts = options || {};
    const apiKey = requireConfigString(opts.apiKey, "apiKey");
    const baseUrl = normalizeBaseUrl(opts.baseUrl);
    const models = normalizeModels(opts.models, opts.model);
    const defaultVoice = requireConfigString(opts.voice, "voice");
    const fetchImpl = opts.fetchImpl || (root && root.fetch);
    if (typeof fetchImpl !== "function") {
      throw new TypeError("A fetch implementation is required for Gemini TTS.");
    }

    return {
      async synthesize(request) {
        const input = request || {};
        const text = requireConfigString(input.text, "text");
        const voice = input.voice ? requireConfigString(input.voice, "voice") : defaultVoice;
        if (input.speed != null && input.speed !== 1) {
          throw new Error("Gemini TTS adapter currently requires speed=1.");
        }

        let earliestCooldownMs = Infinity;
        for (let index = 0; index < models.length; index += 1) {
          if (input.signal?.aborted) throw createAbortError();
          const model = models[index];
          const nowMs = Date.now();
          const remainingCooldownMs = getRemainingCooldownMs(baseUrl, model, nowMs);
          if (remainingCooldownMs > 0) {
            earliestCooldownMs = Math.min(earliestCooldownMs, remainingCooldownMs);
            continue;
          }

          const response = await fetchImpl(baseUrl + "/interactions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": apiKey
            },
            body: JSON.stringify({
              model,
              input: [{
                type: "user_input",
                content: [{
                  type: "text",
                  text
                }]
              }],
              response_format: {
                type: "audio",
                mime_type: "audio/wav"
              },
              generation_config: {
                speech_config: [{ voice }]
              }
            }),
            signal: input.signal
          });

          if (!response.ok) {
            const detail = await readErrorBody(response, apiKey);
            const hasFallback = index + 1 < models.length;
            if (response.status === 429) {
              const retryAfterMs = parseRetryAfterMs(response, detail);
              setModelCooldown(baseUrl, model, retryAfterMs, Date.now());
              earliestCooldownMs = Math.min(earliestCooldownMs, retryAfterMs);
              if (hasFallback) continue;
            }
            throw new Error(
              "Gemini TTS request failed (" + response.status + ")" +
              (detail ? ": " + detail : "")
            );
          }

          let payload;
          try {
            payload = await response.json();
          } catch {
            throw new Error("Gemini TTS returned a non-JSON HTTP response.");
          }
          const audioBlock = findAudioBlock(payload);
          if (!audioBlock) throw new Error("Gemini TTS response contained no audio block.");
          const audio = decodeBase64(audioBlock.data);
          if (!audio.byteLength) throw new Error("Gemini TTS returned empty audio.");

          return {
            audio,
            mimeType: audioBlock.mime_type || audioBlock.mimeType || "audio/wav",
            model
          };
        }

        if (Number.isFinite(earliestCooldownMs)) {
          throw new Error(
            "Gemini TTS models are rate-limited. Retry in about " +
            Math.max(1, Math.ceil(earliestCooldownMs / 1000)) + "s."
          );
        }
        throw new Error("Gemini TTS exhausted configured models.");
      }
    };
  }

  return {
    createGeminiTTSProvider,
    _resetCooldownsForTests() {
      modelCooldownUntil.clear();
    }
  };
});
