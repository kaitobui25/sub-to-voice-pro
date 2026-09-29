(function initVieNeuTTSProvider(root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SubToVoiceVieNeuTTS = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function vieneuTTSProviderFactory(root) {
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

  async function readErrorBody(response) {
    try {
      const text = await response.text();
      if (!text) return "";
      try {
        const parsed = JSON.parse(text);
        return String(parsed?.error?.message || parsed?.detail || parsed?.message || text).slice(0, 500);
      } catch {
        return text.slice(0, 500);
      }
    } catch {
      return "";
    }
  }

  function repairStreamingWavHeader(arrayBuffer) {
    if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength < 44) return arrayBuffer;
    const bytes = new Uint8Array(arrayBuffer);
    const isRiff = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
    const isWave = bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45;
    if (!isRiff || !isWave) return arrayBuffer;

    const view = new DataView(arrayBuffer);
    view.setUint32(4, arrayBuffer.byteLength - 8, true);
    const maxSearch = Math.min(bytes.length - 8, 256);
    for (let index = 12; index <= maxSearch; index += 1) {
      if (
        bytes[index] === 0x64 &&
        bytes[index + 1] === 0x61 &&
        bytes[index + 2] === 0x74 &&
        bytes[index + 3] === 0x61
      ) {
        view.setUint32(index + 4, arrayBuffer.byteLength - (index + 8), true);
        break;
      }
    }
    return arrayBuffer;
  }

  function createVieNeuTTSProvider(options) {
    const opts = options || {};
    const baseUrl = normalizeBaseUrl(opts.baseUrl);
    const model = requireConfigString(opts.model, "model");
    const defaultVoice = requireConfigString(opts.voice, "voice");
    const sampleRate = Number(opts.sampleRate);
    if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
      throw new TypeError("sampleRate must be a positive integer.");
    }
    const apiKey = typeof opts.apiKey === "string" ? opts.apiKey.trim() : "";
    const fetchImpl = opts.fetchImpl || (root && root.fetch);
    if (typeof fetchImpl !== "function") {
      throw new TypeError("A fetch implementation is required for VieNeu TTS.");
    }

    return {
      async synthesize(request) {
        const input = request || {};
        const text = requireConfigString(input.text, "text");
        const voice = input.voice ? requireConfigString(input.voice, "voice") : defaultVoice;
        if (input.speed != null && input.speed !== 1) {
          throw new Error("VieNeu local adapter currently requires speed=1 because the server ignores speed.");
        }

        const headers = { "Content-Type": "application/json" };
        if (apiKey) headers.Authorization = "Bearer " + apiKey;
        const response = await fetchImpl(baseUrl + "/audio/speech", {
          method: "POST",
          headers,
          body: JSON.stringify({
            model,
            input: text,
            voice,
            response_format: "wav",
            stream_format: "audio",
            sample_rate: sampleRate
          }),
          signal: input.signal
        });

        if (!response.ok) {
          const detail = await readErrorBody(response);
          throw new Error(
            "VieNeu TTS request failed (" + response.status + ")" + (detail ? ": " + detail : "")
          );
        }

        const audio = repairStreamingWavHeader(await response.arrayBuffer());
        if (!audio.byteLength) throw new Error("VieNeu TTS returned empty audio.");
        return {
          audio,
          mimeType: response.headers?.get?.("content-type") || "audio/wav",
          model
        };
      }
    };
  }

  return {
    createVieNeuTTSProvider,
    repairStreamingWavHeader
  };
});
