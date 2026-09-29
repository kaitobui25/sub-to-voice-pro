(function initProviderRuntime(root, factory) {
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
        model: models[0]
      })
    );
    return new root.SubToVoiceTranslationCore.TranslationManager({
      registry,
      providerName
    });
  }

  function createTTSManager(config) {
    const providerName = config?.provider;
    if (providerName !== "novai") {
      throw new Error("Unsupported TTS provider: " + providerName);
    }
    const registry = new root.SubToVoiceTTSCore.TTSProviderRegistry();
    registry.register(
      providerName,
      root.SubToVoiceNovAI.createNovAIProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
        voice: config.voice
      })
    );
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
