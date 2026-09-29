(function initTranslationCore(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SubToVoiceTranslationCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function translationCoreFactory() {
  "use strict";

  const TRANSLATION_BATCH_SIZE = 10;

  function normalizeProviderName(name) {
    if (typeof name !== "string" || !name.trim()) {
      throw new TypeError("Translation provider name must be a non-empty string.");
    }
    return name.trim();
  }

  function throwIfAborted(signal) {
    if (!signal || !signal.aborted) return;
    if (signal.reason !== undefined) throw signal.reason;
    const error = new Error("Translation aborted.");
    error.name = "AbortError";
    throw error;
  }

  function validateInputLines(lines) {
    if (!Array.isArray(lines)) {
      throw new TypeError("Translation lines must be an array.");
    }
    lines.forEach((line, index) => {
      if (typeof line !== "string") {
        throw new TypeError("Translation line " + index + " must be a string.");
      }
    });
  }

  function validateProviderOutput(output, expectedCount) {
    if (!Array.isArray(output)) {
      throw new TypeError("Translation provider must return an array of strings.");
    }
    if (output.length !== expectedCount) {
      throw new Error(
        "Translation provider returned " + output.length +
        " lines for " + expectedCount + " inputs."
      );
    }

    return output.map((line, index) => {
      if (typeof line !== "string" || !line.trim()) {
        throw new TypeError(
          "Translation provider returned an invalid string at index " + index + "."
        );
      }
      return line.trim();
    });
  }

  function buildDubbingPrompt({ lines, sourceLanguage, targetLanguage }) {
    validateInputLines(lines);
    if (typeof targetLanguage !== "string" || !targetLanguage.trim()) {
      throw new TypeError("targetLanguage must be a non-empty string.");
    }

    const sourceClause = typeof sourceLanguage === "string" && sourceLanguage.trim()
      ? " from " + sourceLanguage.trim()
      : "";
    const count = lines.length;

    return (
      "Translate these " + count + " subtitle lines" + sourceClause +
      " to " + targetLanguage.trim() + ". " +
      "Return ONLY a JSON object {\"lines\": [...]} with exactly " + count +
      " strings in the same order. Preserve names, brand names, and technical " +
      "terms verbatim. No commentary.\n\n" +
      "Each translated line should be concise; prefer shorter natural phrasing " +
      "over literal word-for-word translation so the dub fits the original cue.\n\n" +
      "Input: " + JSON.stringify(lines)
    );
  }

  class TranslationProviderRegistry {
    constructor() {
      this.providers = new Map();
    }

    register(name, provider) {
      const providerName = normalizeProviderName(name);
      if (!provider || typeof provider.translateBatch !== "function") {
        throw new TypeError(
          "Translation provider must implement translateBatch(options)."
        );
      }
      this.providers.set(providerName, provider);
      return this;
    }

    get(name) {
      const providerName = normalizeProviderName(name);
      const provider = this.providers.get(providerName);
      if (!provider) {
        throw new Error("Unknown translation provider: " + providerName);
      }
      return provider;
    }

    has(name) {
      if (typeof name !== "string" || !name.trim()) return false;
      return this.providers.has(name.trim());
    }
  }

  class TranslationManager {
    constructor({ registry, providerName }) {
      if (!registry || typeof registry.get !== "function") {
        throw new TypeError("TranslationManager requires a provider registry.");
      }
      this.registry = registry;
      this.providerName = normalizeProviderName(providerName);
    }

    setProvider(providerName) {
      this.providerName = normalizeProviderName(providerName);
    }

    async translateBatch({ lines, sourceLanguage, targetLanguage, signal }) {
      validateInputLines(lines);
      if (lines.length === 0) return [];
      if (typeof targetLanguage !== "string" || !targetLanguage.trim()) {
        throw new TypeError("targetLanguage must be a non-empty string.");
      }

      throwIfAborted(signal);
      const provider = this.registry.get(this.providerName);
      const translated = [];

      for (let start = 0; start < lines.length; start += TRANSLATION_BATCH_SIZE) {
        throwIfAborted(signal);
        const batch = lines.slice(start, start + TRANSLATION_BATCH_SIZE);
        const prompt = buildDubbingPrompt({
          lines: batch,
          sourceLanguage,
          targetLanguage
        });
        const output = await provider.translateBatch({
          lines: batch,
          sourceLanguage,
          targetLanguage,
          signal,
          prompt
        });
        throwIfAborted(signal);
        translated.push(...validateProviderOutput(output, batch.length));
      }

      return translated;
    }
  }

  return {
    TRANSLATION_BATCH_SIZE,
    TranslationProviderRegistry,
    TranslationManager,
    buildDubbingPrompt
  };
});
