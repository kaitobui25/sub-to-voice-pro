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
const ttsProvider = (env.TTS_PROVIDER || config.tts?.provider || "gemini").trim().toLowerCase();
if (!["gemini", "vieneu"].includes(ttsProvider)) {
  throw new Error("TTS_PROVIDER must be gemini or vieneu.");
}
const ttsSpeed = config.tts?.speed == null ? 1 : config.tts.speed;
const ttsConfig = ttsProvider === "vieneu"
  ? {
      provider: "vieneu",
      baseUrl: config.vieneu_tts?.base_url,
      model: config.vieneu_tts?.model,
      voice: config.vieneu_tts?.voice,
      sampleRate: config.vieneu_tts?.sample_rate,
      maxConcurrency: config.vieneu_tts?.max_concurrency,
      speed: ttsSpeed
    }
  : {
      provider: "gemini",
      baseUrl: config.gemini_tts?.base_url,
      models: config.gemini_tts?.models || [],
      voice: config.gemini_tts?.voice,
      maxConcurrency: config.gemini_tts?.max_concurrency,
      speed: ttsSpeed,
      apiKey: geminiApiKey
    };

const runtimeConfig = {
  translation: {
    provider: config.translation?.provider || "gemini",
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
