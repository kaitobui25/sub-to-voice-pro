(function initProviderRuntime(root, factory) {
  if (typeof importScripts === "function") {
    importScripts(
      "lib/providers/gemini.js",
      "lib/providers/google-translate.js",
      "lib/providers/microsoft-translate.js",
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
    const fallbackProviders = Array.isArray(config.fallbackProviders) ? config.fallbackProviders : [];
    for (const name of fallbackProviders) {
      if (name === "google") {
        registry.register(name, root.SubToVoiceGoogleTranslateProvider.createGoogleTranslateProvider({
          baseUrl: config.google?.baseUrl,
          client: config.google?.client,
          timeoutMs: config.google?.timeoutMs
        }));
      } else if (name === "microsoft") {
        registry.register(name, root.SubToVoiceMicrosoftTranslateProvider.createMicrosoftTranslateProvider({
          authUrl: config.microsoft?.authUrl,
          baseUrl: config.microsoft?.baseUrl,
          tokenTtlMs: config.microsoft?.tokenTtlMs,
          timeoutMs: config.microsoft?.timeoutMs
        }));
      } else {
        throw new Error("Unsupported translation fallback provider: " + name);
      }
    }
    return new root.SubToVoiceTranslationCore.TranslationManager({
      registry,
      providerName,
      fallbackProviders
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
        sampleRate: config.sampleRate,
        busyRetryTimeoutMs: config.busyRetryTimeoutMs,
        busyRetryDelayMs: config.busyRetryDelayMs
      }));
    }
    return new root.SubToVoiceTTSCore.TTSManager({
      registry,
      provider: providerName
    });
  }

  let localStartup = null;
  async function ensureTTSReady(config) {
    if (config?.provider !== "vieneu") return;
    if (localStartup) return localStartup;
    localStartup = (async () => {
      const healthUrl = new URL(config.baseUrl);
      healthUrl.pathname = "/health";
      try {
        const response = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
        if (response.ok && (await response.json()).status === "ok") return;
      } catch {
        // The local server is stopped; request startup from Windows.
      }
      const reply = await chrome.runtime.sendNativeMessage("com.sub_to_voice.vieneu", { action: "start" })
        .catch((error) => {
          throw new Error("VieNeu auto-start unavailable: " + error.message + ". Run npm run vieneu:install-host once.");
        });
      if (!reply?.ok) throw new Error("VieNeu auto-start failed: " + (reply?.error || "unknown error"));
    })();
    try { await localStartup; } finally { localStartup = null; }
  }

  return {
    createTranslationManager,
    createTTSManager,
    ensureTTSReady
  };
});
