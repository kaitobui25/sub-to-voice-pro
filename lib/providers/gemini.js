(function initGeminiTranslationProvider(root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SubToVoiceGeminiTranslationProvider = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function geminiProviderFactory(root) {
  "use strict";

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

  function redactSecret(text, secret) {
    const value = String(text || "");
    return secret ? value.split(secret).join("[redacted]") : value;
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
    const model = requireConfigString(opts.model, "model");
    const baseUrl = requireConfigString(opts.baseUrl, "baseUrl");
    const fetchImpl = opts.fetchImpl || (root && root.fetch);
    if (typeof fetchImpl !== "function") {
      throw new TypeError("A fetch implementation is required for Gemini.");
    }
    const endpoint = buildEndpoint(baseUrl, model);

    return {
      async translateBatch({ signal, prompt }) {
        if (typeof prompt !== "string" || !prompt.trim()) {
          throw new TypeError("Gemini translation requires a non-empty prompt.");
        }

        const response = await fetchImpl(endpoint, {
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
          const suffix = detail ? ": " + detail.slice(0, 500) : "";
          throw new Error("Gemini request failed with HTTP " + response.status + suffix);
        }

        let payload;
        try {
          payload = await response.json();
        } catch {
          throw new Error("Gemini returned a non-JSON HTTP response.");
        }
        return parseLinesFromText(extractResponseText(payload));
      }
    };
  }

  return {
    createGeminiProvider
  };
});
