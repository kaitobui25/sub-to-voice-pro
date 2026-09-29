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
const missing = ["GEMINI_API_KEY"].filter((key) => !env[key]);
if (missing.length) {
  throw new Error("Missing required key(s): " + missing.join(", "));
}

const runtimeConfig = {
  translation: {
    provider: config.translation?.provider || "gemini",
    baseUrl: config.translation?.base_url,
    models: config.translation?.models || [],
    sourceLanguage: config.translation?.source_language || "auto",
    targetLanguage: config.translation?.target_language || "vi",
    apiKey: env.GEMINI_API_KEY
  },
  tts: {
    provider: config.tts?.provider || "gemini",
    baseUrl: config.tts?.base_url,
    model: config.tts?.model,
    voice: config.tts?.voice,
    speed: config.tts?.speed == null ? 1 : config.tts.speed,
    apiKey: env.GEMINI_API_KEY
  },
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
