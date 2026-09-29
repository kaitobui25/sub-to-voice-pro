(function initGeminiTTSProvider(root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SubToVoiceGeminiTTS = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function geminiTTSProviderFactory(root) {
  "use strict";

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

        for (let index = 0; index < models.length; index += 1) {
          const model = models[index];
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
            if (response.status === 429 && hasFallback) continue;
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

        throw new Error("Gemini TTS exhausted configured models.");
      }
    };
  }

  return {
    createGeminiTTSProvider
  };
});
