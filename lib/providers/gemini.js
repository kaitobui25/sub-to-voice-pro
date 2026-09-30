(function initGeminiTranslationProvider(root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SubToVoiceGeminiTranslationProvider = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function geminiProviderFactory(root) {
  "use strict";

  const modelCooldownUntil = new Map();
  const modelCursor = new Map();

  function requireConfigString(value, name) {
    if (typeof value !== "string" || !value.trim()) {
      throw new TypeError(name + " must be a non-empty string.");
    }
    return value.trim();
  }

  function buildEndpoint(baseUrl, model) {
    const base = requireConfigString(baseUrl, "baseUrl").replace(/\/+$/, "");
    const modelName = requireConfigString(model, "model").replace(/^models\//, "");
    return base + "/models/" + encodeURIComponent(modelName) + ":generateContent";
  }

  function normalizeModels(values, legacyModel) {
    const source = Array.isArray(values) && values.length ? values : [legacyModel];
    const models = source
      .filter(Boolean)
      .map((value) => requireConfigString(value, "model").replace(/^models\//, ""));
    if (!models.length) throw new TypeError("models must contain at least one model.");
    return [...new Set(models)];
  }

  function redactSecret(text, secret) {
    const value = String(text || "");
    return secret ? value.split(secret).join("[redacted]") : value;
  }

  function parseRetryAfterMs(response, detail, defaultMs) {
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
    if (!match) return defaultMs;
    const value = Number(match[1]);
    const unit = match[2].toLowerCase();
    if (unit.startsWith("ms")) return Math.max(1000, Math.ceil(value));
    if (unit.startsWith("m") && !unit.startsWith("ms")) {
      return Math.max(1000, Math.ceil(value * 60000));
    }
    return Math.max(1000, Math.ceil(value * 1000));
  }

  function poolKey(baseUrl, models) {
    return baseUrl.replace(/\/+$/, "") + "|" + models.join(",");
  }

  function cooldownKey(baseUrl, model) {
    return baseUrl.replace(/\/+$/, "") + "|" + model;
  }

  function getRemainingCooldownMs(baseUrl, model, nowMs) {
    const key = cooldownKey(baseUrl, model);
    const until = modelCooldownUntil.get(key) || 0;
    if (until <= nowMs) {
      modelCooldownUntil.delete(key);
      return 0;
    }
    return until - nowMs;
  }

  function setCooldown(baseUrl, model, retryAfterMs, nowMs) {
    modelCooldownUntil.set(
      cooldownKey(baseUrl, model),
      nowMs + Math.max(1000, retryAfterMs)
    );
  }

  function createAbortError() {
    const error = new Error("Gemini translation request aborted.");
    error.name = "AbortError";
    return error;
  }

  function isTransientServerStatus(status) {
    return status === 500 || status === 502 || status === 503 || status === 504;
  }

  function extractResponseText(payload) {
    const parts = payload && payload.candidates && payload.candidates[0] &&
      payload.candidates[0].content && payload.candidates[0].content.parts;
    if (!Array.isArray(parts)) return "";
    return parts
      .map((part) => part && typeof part.text === "string" ? part.text : "")
      .join("")
      .trim();
  }

  function parseLinesFromText(rawText) {
    const text = String(rawText || "").trim();
    if (!text) throw new Error("Gemini returned no translation content.");

    const jsonText = text.startsWith("```")
      ? text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
      : text;

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      throw new Error("Gemini returned malformed JSON.");
    }

    if (!parsed || !Array.isArray(parsed.lines)) {
      throw new Error("Gemini response JSON must contain a lines array.");
    }
    return parsed.lines;
  }

  function createGeminiProvider(options) {
    const opts = options || {};
    const apiKey = requireConfigString(opts.apiKey, "apiKey");
    const models = normalizeModels(opts.models, opts.model);
    const baseUrl = requireConfigString(opts.baseUrl, "baseUrl");
    const fetchImpl = opts.fetchImpl || (root && root.fetch);
    if (typeof fetchImpl !== "function") {
      throw new TypeError("A fetch implementation is required for Gemini.");
    }
    const cursorKey = poolKey(baseUrl, models);

    return {
      async translateBatch({ signal, prompt }) {
        if (typeof prompt !== "string" || !prompt.trim()) {
          throw new TypeError("Gemini translation requires a non-empty prompt.");
        }
        if (signal?.aborted) throw createAbortError();

        const startIndex = modelCursor.get(cursorKey) || 0;
        let earliestCooldownMs = Infinity;

        for (let offset = 0; offset < models.length; offset += 1) {
          if (signal?.aborted) throw createAbortError();
          const index = (startIndex + offset) % models.length;
          const model = models[index];
          const remainingCooldownMs = getRemainingCooldownMs(baseUrl, model, Date.now());
          if (remainingCooldownMs > 0) {
            earliestCooldownMs = Math.min(earliestCooldownMs, remainingCooldownMs);
            continue;
          }

          const response = await fetchImpl(buildEndpoint(baseUrl, model), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": apiKey
            },
            body: JSON.stringify({
              contents: [{
                role: "user",
                parts: [{ text: prompt }]
              }],
              generationConfig: {
                temperature: 0.2,
                responseMimeType: "application/json"
              }
            }),
            signal
          });

          if (!response.ok) {
            let detail = "";
            try {
              detail = await response.text();
            } catch {
              detail = "";
            }
            detail = redactSecret(detail, apiKey).trim();

            if (response.status === 429 || isTransientServerStatus(response.status)) {
              const retryAfterMs = parseRetryAfterMs(
                response,
                detail,
                response.status === 429 ? 60000 : 10000
              );
              setCooldown(baseUrl, model, retryAfterMs, Date.now());
              earliestCooldownMs = Math.min(earliestCooldownMs, retryAfterMs);
              modelCursor.set(cursorKey, (index + 1) % models.length);
              continue;
            }

            const suffix = detail ? ": " + detail.slice(0, 500) : "";
            throw new Error("Gemini request failed with HTTP " + response.status + suffix);
          }

          let payload;
          try {
            payload = await response.json();
          } catch {
            throw new Error("Gemini returned a non-JSON HTTP response.");
          }
          const lines = parseLinesFromText(extractResponseText(payload));
          modelCursor.set(cursorKey, (index + 1) % models.length);
          return lines;
        }

        if (Number.isFinite(earliestCooldownMs)) {
          throw new Error(
            "Gemini translation models are temporarily unavailable or rate-limited. Retry in about " +
            Math.max(1, Math.ceil(earliestCooldownMs / 1000)) + "s."
          );
        }
        throw new Error("Gemini translation exhausted configured models.");
      }
    };
  }

  return {
    createGeminiProvider,
    _resetModelStateForTests() {
      modelCooldownUntil.clear();
      modelCursor.clear();
    }
  };
});
