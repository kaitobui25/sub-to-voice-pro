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
    const temperature = Number.isFinite(Number(opts.temperature)) ? Number(opts.temperature) : 0.2;
    const responseSchema = opts.responseSchema || null;
    const retryInvalidResponse = opts.retryInvalidResponse === true;
    const preferFirstModel = opts.preferFirstModel === true;
    const attemptTimeoutMs = Number.isFinite(Number(opts.attemptTimeoutMs))
      ? Math.max(1000, Number(opts.attemptTimeoutMs)) : 0;
    const validateOutput = typeof opts.validateOutput === "function" ? opts.validateOutput : null;
    if (typeof fetchImpl !== "function") {
      throw new TypeError("A fetch implementation is required for Gemini.");
    }
    const cursorKey = poolKey(baseUrl, models);

    return {
      async translateBatch({ signal, prompt, lines: inputLines = [], batchStart = 0 }) {
        if (typeof prompt !== "string" || !prompt.trim()) {
          throw new TypeError("Gemini translation requires a non-empty prompt.");
        }
        if (signal?.aborted) throw createAbortError();

        const startIndex = preferFirstModel ? 0 : (modelCursor.get(cursorKey) || 0);
        let earliestCooldownMs = Infinity;
        let lastInvalidError = null;

        for (let offset = 0; offset < models.length; offset += 1) {
          if (signal?.aborted) throw createAbortError();
          const index = (startIndex + offset) % models.length;
          const model = models[index];
          const remainingCooldownMs = getRemainingCooldownMs(baseUrl, model, Date.now());
          if (remainingCooldownMs > 0) {
            earliestCooldownMs = Math.min(earliestCooldownMs, remainingCooldownMs);
            continue;
          }

          const generationConfig = {
            temperature,
            responseMimeType: "application/json"
          };
          if (responseSchema) generationConfig.responseSchema = responseSchema;
          if (opts.maxOutputTokens) generationConfig.maxOutputTokens = opts.maxOutputTokens;
          const startedAt = Date.now();
          const attempt = { model, startedAt: new Date(startedAt).toISOString(),
            lineCount: inputLines.length, batchStart, inputChars: prompt.length,
            outcome: "error" };

          const attemptController = attemptTimeoutMs > 0 ? new AbortController() : null;
          let attemptTimedOut = false;
          let attemptTimer = null;
          const onParentAbort = () => attemptController?.abort();
          if (attemptController && signal) signal.addEventListener("abort", onParentAbort, { once: true });
          if (attemptController) {
            attemptTimer = setTimeout(() => {
              attemptTimedOut = true;
              attemptController.abort();
            }, attemptTimeoutMs);
          }
          try {
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
                generationConfig
              }),
              signal: attemptController ? attemptController.signal : signal
            });
            attempt.httpStatus = response.status;
            if (!response.ok) {
              let detail = "";
              try {
                detail = await response.text();
              } catch {
                detail = "";
              }
              detail = redactSecret(detail, apiKey).trim();
              attempt.error = detail.slice(0, 1500);
              attempt.errorType = "http";
              attempt.retryAfterHeader = response.headers?.get?.("retry-after") || null;

              if (response.status === 429 || isTransientServerStatus(response.status)) {
                const retryAfterMs = parseRetryAfterMs(response, detail, response.status === 429 ? 60000 : 10000);
                setCooldown(baseUrl, model, retryAfterMs, Date.now());
                attempt.retryAfterMs = retryAfterMs;
                earliestCooldownMs = Math.min(earliestCooldownMs, retryAfterMs);
                if (!preferFirstModel) modelCursor.set(cursorKey, (index + 1) % models.length);
                continue;
              }

              const suffix = detail ? ": " + detail.slice(0, 500) : "";
              throw new Error("Gemini request failed with HTTP " + response.status + suffix);
            }

            let payload;
            try {
              payload = await response.json();
            } catch {
              attempt.errorType = "invalid_http_json";
              throw new Error("Gemini returned a non-JSON HTTP response.");
            }
            attempt.usage = payload.usageMetadata || null;
            attempt.modelVersion = payload.modelVersion || model;
            attempt.finishReason = payload.candidates?.[0]?.finishReason || null;
            try {
              const lines = parseLinesFromText(extractResponseText(payload));
              attempt.outputLineCount = lines.length;
              const validated = validateOutput ? validateOutput(lines, { lines: inputLines }) : lines;
              attempt.outcome = "success";
              if (!preferFirstModel) modelCursor.set(cursorKey, (index + 1) % models.length);
              return validated;
            } catch (error) {
              attempt.errorType = "invalid_output";
              attempt.error = redactSecret(error.message, apiKey);
              if (!retryInvalidResponse) throw error;
              lastInvalidError = error;
              if (!preferFirstModel) modelCursor.set(cursorKey, (index + 1) % models.length);
              continue;
            }
          } catch (error) {
            attempt.error = redactSecret(attempt.error || error.message, apiKey).slice(0, 1500);
            if (signal?.aborted) { attempt.errorType = "aborted"; throw createAbortError(); }
            if (!attemptTimedOut) { attempt.errorType ||= "network"; throw error; }
            attempt.errorType = "timeout";
            lastInvalidError = new Error("Gemini model attempt timed out: " + model);
            if (!preferFirstModel) modelCursor.set(cursorKey, (index + 1) % models.length);
          } finally {
            if (attemptTimer != null) clearTimeout(attemptTimer);
            if (attemptController && signal) signal.removeEventListener("abort", onParentAbort);
            attempt.durationMs = Date.now() - startedAt;
            opts.onAttempt?.(attempt);
          }
        }

        if (Number.isFinite(earliestCooldownMs)) {
          throw new Error(
            "Gemini translation models are temporarily unavailable or rate-limited. Retry in about " +
            Math.max(1, Math.ceil(earliestCooldownMs / 1000)) + "s."
          );
        }
        if (lastInvalidError) throw lastInvalidError;
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
