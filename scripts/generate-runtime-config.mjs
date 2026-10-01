import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const envPath = path.join(root, ".env");
const configPath = path.join(root, "config.yaml");
const outputPath = path.join(root, "runtime-config.local.json");

function parseEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    values[key] = value;
  }
  return values;
}

function scalar(value) {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function parseSimpleYaml(text) {
  const result = {};
  let section = null;
  let listKey = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const withoutComment = rawLine.replace(/\s+#.*$/, "");
    if (!withoutComment.trim()) continue;
    const indent = withoutComment.match(/^\s*/)[0].length;
    const line = withoutComment.trim();

    if (indent === 0 && line.endsWith(":")) {
      section = line.slice(0, -1);
      result[section] = result[section] || {};
      listKey = null;
      continue;
    }
    if (!section) continue;

    if (indent === 2 && line.endsWith(":")) {
      listKey = line.slice(0, -1);
      result[section][listKey] = [];
      continue;
    }

    if (indent >= 4 && line.startsWith("- ") && listKey) {
      result[section][listKey].push(scalar(line.slice(2)));
      continue;
    }

    if (indent === 2) {
      const separator = line.indexOf(":");
      if (separator === -1) continue;
      const key = line.slice(0, separator).trim();
      result[section][key] = scalar(line.slice(separator + 1));
      listKey = null;
    }
  }
  return result;
}

if (!fs.existsSync(envPath)) {
  throw new Error("Missing .env. Copy .env.example and add local provider keys.");
}

const env = parseEnv(fs.readFileSync(envPath, "utf8"));
const config = parseSimpleYaml(fs.readFileSync(configPath, "utf8"));
const geminiApiKey = env.GEMINI_API_KEY1 || env.GEMINI_API_KEY;
if (!geminiApiKey) {
  throw new Error("Missing GEMINI_API_KEY1 (or legacy GEMINI_API_KEY).");
}
const ttsProvider = (env.TTS_PROVIDER || config.tts?.provider || "vieneu").trim().toLowerCase();
if (!["gemini", "vieneu"].includes(ttsProvider)) {
  throw new Error("TTS_PROVIDER must be gemini or vieneu.");
}
const ttsSpeed = config.tts?.speed == null ? 1 : config.tts.speed;
const ttsProfiles = {
  vieneu: {
      provider: "vieneu",
      baseUrl: config.vieneu_tts?.base_url,
      model: config.vieneu_tts?.model,
      voice: config.vieneu_tts?.voice,
      speakerVoices: config.vieneu_tts?.speaker_voices || [],
      sampleRate: config.vieneu_tts?.sample_rate,
      maxConcurrency: config.vieneu_tts?.max_concurrency,
      busyRetryTimeoutMs: config.vieneu_tts?.busy_retry_timeout_ms,
      busyRetryDelayMs: config.vieneu_tts?.busy_retry_delay_ms,
      speed: ttsSpeed
    },
  gemini: {
      provider: "gemini",
      baseUrl: config.gemini_tts?.base_url,
      models: config.gemini_tts?.models || [],
      voice: config.gemini_tts?.voice,
      maxConcurrency: config.gemini_tts?.max_concurrency,
      speed: ttsSpeed,
      apiKey: geminiApiKey
    }
};
const ttsConfig = {
  ...ttsProfiles[ttsProvider],
  defaultSelection: config.tts?.default_selection || ttsProvider,
  autoOrder: config.tts?.auto_order || ["vieneu", "gemini"],
  autoBusyRetryTimeoutMs: config.tts?.auto_busy_retry_timeout_ms,
  profiles: ttsProfiles
};

const runtimeConfig = {
  translation: {
    provider: config.translation?.provider || "gemini",
    defaultSelection: config.translation?.default_selection || config.translation?.provider || "google",
    orders: {
      google: config.translation?.google_order || ["google", "microsoft"],
      gemini: config.translation?.gemini_order || ["gemini"],
      auto: config.translation?.auto_order || ["google", "microsoft", "gemini"]
    },
    baseUrl: config.translation?.base_url,
    models: config.translation?.models || [],
    fallbackProviders: config.translation?.fallback_providers || [],
    google: {
      baseUrl: config.google_translate?.base_url,
      client: config.google_translate?.client,
      timeoutMs: config.google_translate?.timeout_ms
    },
    microsoft: {
      authUrl: config.microsoft_translate?.auth_url,
      baseUrl: config.microsoft_translate?.base_url,
      tokenTtlMs: config.microsoft_translate?.token_ttl_ms,
      timeoutMs: config.microsoft_translate?.timeout_ms
    },
    sourceLanguage: config.translation?.source_language || "auto",
    targetLanguage: config.translation?.target_language || "vi",
    apiKey: geminiApiKey
  },
  speakerDetection: {
    renderBatchSize: config.speaker_detection?.render_batch_size || 8,
    maxLinesPerRequest: config.speaker_detection?.max_lines_per_request || 600,
    maxPromptChars: config.speaker_detection?.max_prompt_chars || 60000,
    contextSize: config.speaker_detection?.context_size || 16,
    timeoutMs: config.speaker_detection?.timeout_ms || 25000,
    modelTimeoutMs: config.speaker_detection?.model_timeout_ms || 10000,
    models: config.speaker_detection?.models || config.translation?.models || [],
    lookaheadSeconds: config.speaker_detection?.lookahead_seconds || 60,
    maxLookaheadSeconds: config.speaker_detection?.max_lookahead_seconds || 120
  },
  tts: ttsConfig,
  audio: {
    originalVolume: config.audio?.original_volume == null ? 18 : config.audio.original_volume,
    voiceVolume: config.audio?.voice_volume == null ? 100 : config.audio.voice_volume
  }
};

fs.writeFileSync(outputPath, JSON.stringify(runtimeConfig, null, 2) + "\n", {
  encoding: "utf8",
  mode: 0o600
});
console.log("Generated runtime-config.local.json with configured provider credentials.");
