(function initTTSCore(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SubToVoiceTTSCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function ttsCoreFactory() {
  "use strict";

  function createAbortError() {
    const error = new Error("TTS synthesis aborted.");
    error.name = "AbortError";
    return error;
  }

  function validateProvider(name, provider) {
    if (typeof name !== "string" || !name.trim()) {
      throw new TypeError("TTS provider name must be a non-empty string.");
    }
    if (!provider || typeof provider.synthesize !== "function") {
      throw new TypeError(`TTS provider \"${name}\" must implement synthesize().`);
    }
  }

  function validateRequest(request) {
    if (!request || typeof request !== "object") {
      throw new TypeError("TTS synthesize() requires a request object.");
    }
    if (typeof request.text !== "string" || !request.text.trim()) {
      throw new TypeError("TTS text must be a non-empty string.");
    }
    if (request.voice != null && typeof request.voice !== "string") {
      throw new TypeError("TTS voice must be a string when provided.");
    }
    if (request.speed != null && (!Number.isFinite(request.speed) || request.speed <= 0)) {
      throw new TypeError("TTS speed must be a positive finite number when provided.");
    }
  }

  function validateResult(result) {
    if (!result || !(result.audio instanceof ArrayBuffer)) {
      throw new TypeError("TTS provider must return audio as an ArrayBuffer.");
    }
    if (result.audio.byteLength === 0) {
      throw new Error("TTS provider returned empty audio.");
    }
    if (typeof result.mimeType !== "string" || !result.mimeType.trim()) {
      throw new TypeError("TTS provider must return a non-empty mimeType.");
    }
    return result;
  }

  class TTSProviderRegistry {
    constructor() {
      this.providers = new Map();
    }

    register(name, provider) {
      validateProvider(name, provider);
      this.providers.set(name.trim(), provider);
      return this;
    }

    has(name) {
      return this.providers.has(name);
    }

    get(name) {
      const provider = this.providers.get(name);
      if (!provider) throw new Error(`Unknown TTS provider: ${name}`);
      return provider;
    }

    list() {
      return Array.from(this.providers.keys());
    }
  }

  class TTSManager {
    constructor(options) {
      const opts = options || {};
      this.registry = opts.registry || new TTSProviderRegistry();
      if (!this.registry || typeof this.registry.get !== "function") {
        throw new TypeError("TTSManager requires a provider registry with get().");
      }
      this.providerName = opts.provider || null;
    }

    setProvider(name) {
      this.registry.get(name);
      this.providerName = name;
      return this;
    }

    async synthesize(request) {
      validateRequest(request);
      if (request.signal && request.signal.aborted) throw createAbortError();
      if (!this.providerName) throw new Error("No TTS provider selected.");

      const provider = this.registry.get(this.providerName);
      const result = await provider.synthesize({
        text: request.text,
        voice: request.voice,
        speed: request.speed,
        signal: request.signal
      });
      return validateResult(result);
    }
  }

  return {
    TTSManager,
    TTSProviderRegistry
  };
});
