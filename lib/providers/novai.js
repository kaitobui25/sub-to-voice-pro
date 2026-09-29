(function initNovAIProvider(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SubToVoiceNovAI = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function novaiProviderFactory() {
  "use strict";

  const DEFAULT_BASE_URL = "https://aiapi-pro.com/v1";
  const DEFAULT_MODEL = "minimax-speech-2.8-turbo";
  const DEFAULT_VOICE = "male-qn-qingse";
  const DEFAULT_RESPONSE_FORMAT = "mp3";
  const MIME_BY_FORMAT = {
    mp3: "audio/mpeg",
    wav: "audio/wav"
  };

  function normalizeBaseUrl(value) {
    return String(value || DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  function cleanContentType(value) {
    return String(value || "").split(";", 1)[0].trim().toLowerCase();
  }

  async function readErrorBody(response) {
    try {
      const text = await response.text();
      if (!text) return "";
      try {
        const parsed = JSON.parse(text);
        return String(parsed?.error?.message || parsed?.message || text).slice(0, 500);
      } catch {
        return text.slice(0, 500);
      }
    } catch {
      return "";
    }
  }

  function createNovAIProvider(options) {
    const opts = options || {};
    const apiKey = opts.apiKey;
    const baseUrl = normalizeBaseUrl(opts.baseUrl);
    const model = opts.model || DEFAULT_MODEL;
    const defaultVoice = opts.voice || DEFAULT_VOICE;
    const responseFormat = opts.responseFormat || DEFAULT_RESPONSE_FORMAT;
    const fetchImpl = opts.fetch || (typeof globalThis !== "undefined" ? globalThis.fetch : null);

    if (!apiKey || typeof apiKey !== "string") {
      throw new Error("NovAI API key is required.");
    }
    if (!MIME_BY_FORMAT[responseFormat]) {
      throw new Error("NovAI responseFormat must be mp3 or wav for complete-file TTS.");
    }
    if (typeof fetchImpl !== "function") {
      throw new Error("NovAI provider requires fetch().");
    }

    return {
      async synthesize(request) {
        const input = request || {};
        const voice = input.voice || defaultVoice;
        const body = {
          model,
          input: input.text,
          voice,
          response_format: responseFormat
        };
        if (input.speed != null) body.speed = input.speed;

        const response = await fetchImpl(`${baseUrl}/audio/speech`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body),
          signal: input.signal
        });

        if (!response.ok) {
          const detail = await readErrorBody(response);
          const suffix = detail ? `: ${detail}` : "";
          throw new Error(`NovAI TTS request failed (${response.status})${suffix}`);
        }

        const contentType = cleanContentType(response.headers?.get?.("content-type"));
        if (contentType && !contentType.startsWith("audio/") && contentType !== "application/octet-stream") {
          throw new Error(`NovAI TTS returned unexpected content type: ${contentType}`);
        }

        const audio = await response.arrayBuffer();
        if (!(audio instanceof ArrayBuffer) || audio.byteLength === 0) {
          throw new Error("NovAI TTS returned empty audio.");
        }

        return {
          audio,
          mimeType: contentType && contentType.startsWith("audio/")
            ? contentType
            : MIME_BY_FORMAT[responseFormat]
        };
      }
    };
  }

  return {
    DEFAULT_BASE_URL,
    DEFAULT_MODEL,
    DEFAULT_VOICE,
    DEFAULT_RESPONSE_FORMAT,
    createNovAIProvider
  };
});
