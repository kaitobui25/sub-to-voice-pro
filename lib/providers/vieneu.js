(function initVieNeuTTSProvider(root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SubToVoiceVieNeuTTS = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function vieneuTTSProviderFactory(root) {
  "use strict";

  const now = () => root.performance?.now?.() ?? Date.now();
  const HEALTH_CACHE_MS = 5000;
  const HEALTH_TIMEOUT_MS = 1000;
  const healthCache = new Map();

  function serverSnapshot(baseUrl, fetchImpl) {
    const cached = healthCache.get(baseUrl);
    if (cached && Date.now() - cached.at < HEALTH_CACHE_MS) return cached.promise;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const promise = Promise.resolve().then(async () => {
      const response = await fetchImpl(baseUrl.replace(/\/v1$/, "") + "/health", { signal: controller.signal });
      if (!response.ok) throw new Error("Health HTTP " + response.status);
      const health = await response.json();
      return {
        observedAt: new Date().toISOString(), status: health.status, backend: health.backend,
        device: health.device ?? null, active: health.active, waiting: health.waiting,
        maxStreams: health.max_streams,
        hardwareMetricsAvailable: false
      };
    }).catch((error) => ({ unavailable: true, error: error?.message || String(error) }))
      .finally(() => clearTimeout(timer));
    healthCache.set(baseUrl, { at: Date.now(), promise });
    return promise;
  }

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

  function waitForRetry(delayMs, signal) {
    return new Promise((resolve, reject) => {
      let timer;
      const aborted = () => {
        clearTimeout(timer);
        const error = new Error("VieNeu TTS request aborted.");
        error.name = "AbortError";
        reject(error);
      };
      if (signal?.aborted) return aborted();
      timer = setTimeout(() => {
        signal?.removeEventListener("abort", aborted);
        resolve();
      }, delayMs);
      signal?.addEventListener("abort", aborted, { once: true });
    });
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
    const busyRetryTimeoutMs = Number(opts.busyRetryTimeoutMs || 0);
    const busyRetryDelayMs = Number(opts.busyRetryDelayMs || 0);
    if (busyRetryTimeoutMs > 0 && !(busyRetryDelayMs > 0)) {
      throw new TypeError("busyRetryDelayMs must be positive when busy retries are enabled.");
    }
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
        const deadline = Date.now() + busyRetryTimeoutMs;
        const started = now();
        const telemetry = { provider: "vieneu", model, attempts: [], busyRetryCount: 0, busyWaitMs: 0 };
        const health = serverSnapshot(baseUrl, fetchImpl);
        try {
        for (;;) {
          const attemptStart = now();
          const attempt = { offsetMs: attemptStart - started };
          telemetry.attempts.push(attempt);
          const response = await fetchImpl(baseUrl + "/audio/speech", {
            method: "POST",
            headers,
            body: JSON.stringify({
              model,
              input: text,
              voice,
              response_format: "wav",
              stream_format: "audio",
              ...(opts.completeAudio === true ? { complete_audio: true } : {}),
              sample_rate: sampleRate
            }),
            signal: input.signal
          });
          attempt.headersMs = now() - attemptStart;
          attempt.status = response.status;
          attempt.serverRequestId = response.headers?.get?.("x-request-id") || null;
          const queueHeader = response.headers?.get?.("x-vieneu-queue-ms");
          attempt.serverQueueMs = queueHeader != null && Number.isFinite(Number(queueHeader)) ? Number(queueHeader) : null;

          if (response.status === 429 && busyRetryTimeoutMs > 0) {
            const remaining = deadline - Date.now();
            const retryAfter = Number(response.headers?.get?.("retry-after"));
            const delay = Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter * 1000 : busyRetryDelayMs;
            if (remaining > delay) {
              const waitStarted = now();
              telemetry.busyRetryCount += 1;
              await waitForRetry(delay, input.signal);
              attempt.retryWaitMs = now() - waitStarted;
              telemetry.busyWaitMs += attempt.retryWaitMs;
              continue;
            }
          }
          if (!response.ok) {
            const detail = await readErrorBody(response);
            throw new Error(
              "VieNeu TTS request failed (" + response.status + ")" + (detail ? ": " + detail : "")
            );
          }

          const bodyStarted = now();
          const rawAudio = await response.arrayBuffer();
          attempt.bodyMs = now() - bodyStarted;
          const repairStarted = now();
          const audio = repairStreamingWavHeader(rawAudio);
          telemetry.wavRepairMs = now() - repairStarted;
          telemetry.audioBytes = audio.byteLength;
          telemetry.totalMs = now() - started;
          telemetry.server = await health;
          if (attempt.serverQueueMs != null && attempt.serverRequestId) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
            const diagnosticStarted = now();
            try {
              const detail = await fetchImpl(baseUrl + "/diagnostics/" + encodeURIComponent(attempt.serverRequestId), {
                headers: apiKey ? { Authorization: "Bearer " + apiKey } : {}, signal: controller.signal
              });
              telemetry.serverRequest = detail.ok ? await detail.json() : { unavailable: true, status: detail.status };
            } catch (error) {
              telemetry.serverRequest = { unavailable: true, error: error?.message || String(error) };
            } finally {
              clearTimeout(timer);
              telemetry.diagnosticsFetchMs = now() - diagnosticStarted;
            }
          }
          if (!audio.byteLength) throw new Error("VieNeu TTS returned empty audio.");
          return {
            audio,
            mimeType: response.headers?.get?.("content-type") || "audio/wav",
            model,
            telemetry
          };
        }
        } catch (error) {
          telemetry.totalMs = now() - started;
          telemetry.server = await health;
          error.telemetry = telemetry;
          throw error;
        }
      }
    };
  }

  return {
    createVieNeuTTSProvider,
    repairStreamingWavHeader
  };
});
