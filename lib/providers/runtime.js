(function initProviderRuntime(root, factory) {
  if (typeof importScripts === "function") {
    importScripts(
      "lib/providers/gemini.js",
      "lib/providers/gemini-tts.js",
      "lib/providers/vieneu.js"
    );
  }
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SubToVoiceProviderRuntime = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function providerRuntimeFactory(root) {
  "use strict";

  function createTranslationManager(config) {
    const providerName = config?.provider;
    if (providerName !== "gemini") {
      throw new Error("Unsupported translation provider: " + providerName);
    }
    const models = Array.isArray(config.models) ? config.models.filter(Boolean) : [];
    if (!models.length) throw new Error("No translation model configured.");

    const registry = new root.SubToVoiceTranslationCore.TranslationProviderRegistry();
    registry.register(
      providerName,
      root.SubToVoiceGeminiTranslationProvider.createGeminiProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        models
      })
    );
    return new root.SubToVoiceTranslationCore.TranslationManager({
      registry,
      providerName
    });
  }

  function createTTSManager(config) {
    const providerName = config?.provider;
    if (!["gemini", "vieneu"].includes(providerName)) {
      throw new Error("Unsupported TTS provider: " + providerName);
    }
    const registry = new root.SubToVoiceTTSCore.TTSProviderRegistry();
    if (providerName === "gemini") {
      registry.register(providerName, root.SubToVoiceGeminiTTS.createGeminiTTSProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        models: config.models,
        voice: config.voice
      }));
    } else {
      registry.register(providerName, root.SubToVoiceVieNeuTTS.createVieNeuTTSProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
        voice: config.voice,
        sampleRate: config.sampleRate
      }));
    }
    return new root.SubToVoiceTTSCore.TTSManager({
      registry,
      provider: providerName
    });
  }

  return {
    createTranslationManager,
    createTTSManager
  };
});
