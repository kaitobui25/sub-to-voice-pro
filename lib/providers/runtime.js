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
    if (!["gemini", "google", "microsoft"].includes(providerName)) {
      throw new Error("Unsupported translation provider: " + providerName);
    }
    const registry = new root.SubToVoiceTranslationCore.TranslationProviderRegistry();
    const fallbackProviders = Array.isArray(config.fallbackProviders) ? config.fallbackProviders : [];
    for (const name of new Set([providerName, ...fallbackProviders])) {
      if (name === "gemini") {
        const models = Array.isArray(config.models) ? config.models.filter(Boolean) : [];
        if (!models.length) throw new Error("No translation model configured.");
        registry.register(name, root.SubToVoiceGeminiTranslationProvider.createGeminiProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        models
        }));
      } else if (name === "google") {
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
        throw new Error("Unsupported translation provider: " + name);
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

  const selections = {
    translation: ["google", "gemini", "auto"],
    tts: ["vieneu", "gemini", "auto"]
  };

  function validSelection(kind, value) {
    return selections[kind]?.includes(value) || false;
  }

  function resolveSelections(config, saved) {
    return {
      translation: validSelection("translation", saved?.translationSelection)
        ? saved.translationSelection : config.translation?.defaultSelection || "google",
      tts: validSelection("tts", saved?.ttsSelection)
        ? saved.ttsSelection : config.tts?.defaultSelection || "vieneu"
    };
  }

  function ttsProfile(config, selection) {
    const primary = selection === "gemini" ? "gemini" : "vieneu";
    return config.profiles?.[primary] || config;
  }

  function translationConfig(config, selection) {
    const order = config.orders?.[selection] || [config.provider, ...(config.fallbackProviders || [])];
    if (!order.length) throw new Error("No translation provider configured.");
    return { ...config, provider: order[0], fallbackProviders: order.slice(1) };
  }

  async function labelSpeakers(config, speakerConfig, lines, context, signal) {
    const prompt = root.SubToVoiceSpeakerCore.buildPrompt(lines, context);
    const maxPromptChars = Math.max(4000, Number(speakerConfig?.maxPromptChars || 60000));
    if (prompt.length > maxPromptChars) {
      throw new Error("Speaker prompt exceeds configured size limit.");
    }
    const provider = root.SubToVoiceGeminiTranslationProvider.createGeminiProvider({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      models: Array.isArray(speakerConfig?.models) && speakerConfig.models.length
        ? speakerConfig.models : config.models,
      temperature: 0,
      responseSchema: {
        type: "OBJECT",
        properties: {
          lines: { type: "ARRAY", items: { type: "STRING" } }
        },
        required: ["lines"]
      },
      retryInvalidResponse: true,
      preferFirstModel: true,
      attemptTimeoutMs: Math.max(1000, Number(speakerConfig?.modelTimeoutMs || 10000)),
      validateOutput(output) {
        return root.SubToVoiceSpeakerCore.parseLabels(output, lines);
      }
    });
    return provider.translateBatch({
      prompt, signal
    });
  }

  async function ensureInitialTTSReady(config, selection) {
    if (selection === "vieneu") await ensureTTSReady(ttsProfile(config, selection));
  }

  async function synthesizeWithSelection(config, selection, request) {
    const order = selection === "auto" ? config.autoOrder : [selection];
    let lastError;
    for (const name of order || []) {
      if (request.signal?.aborted) throw request.signal.reason || new Error("TTS cancelled.");
      const profile = config.profiles?.[name] || (config.provider === name ? config : null);
      if (!profile) throw new Error("TTS provider is not configured: " + name);
      const providerConfig = selection === "auto" && name === "vieneu"
        ? { ...profile, busyRetryTimeoutMs: config.autoBusyRetryTimeoutMs ?? profile.busyRetryTimeoutMs }
        : profile;
      try {
        await ensureTTSReady(providerConfig);
        const voice = request.multiVoice && name === "vieneu"
          ? root.SubToVoiceSpeakerCore.voiceForSpeaker(
            request.speaker, providerConfig.speakerVoices, providerConfig.voice
          ) : providerConfig.voice;
        return await createTTSManager(providerConfig).synthesize({
          ...request, voice
        });
      } catch (error) {
        if (request.signal?.aborted) throw request.signal.reason || error;
        lastError = error;
      }
    }
    throw lastError || new Error("No TTS provider configured.");
  }

  return {
    createTranslationManager,
    createTTSManager,
    ensureTTSReady,
    validSelection,
    resolveSelections,
    ttsProfile,
    translationConfig,
    labelSpeakers,
    ensureInitialTTSReady,
    synthesizeWithSelection
  };
});
