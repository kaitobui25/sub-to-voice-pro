import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createGeminiTTSProvider } = require("../lib/providers/gemini-tts.js");
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeConfigPath = path.join(rootDir, "runtime-config.local.json");

if (!fs.existsSync(runtimeConfigPath)) {
  throw new Error("Missing runtime-config.local.json. Run npm run config first.");
}

const runtimeConfig = JSON.parse(fs.readFileSync(runtimeConfigPath, "utf8"));
const tts = runtimeConfig.tts?.profiles?.gemini || runtimeConfig.tts || {};

const provider = createGeminiTTSProvider({
  apiKey: tts.apiKey,
  baseUrl: tts.baseUrl,
  models: tts.models,
  voice: tts.voice
});

const result = await provider.synthesize({
  text: "Xin chào.",
  voice: tts.voice,
  speed: tts.speed == null ? 1 : tts.speed
});

if (!(result.audio instanceof ArrayBuffer) || result.audio.byteLength < 44) {
  throw new Error("Gemini TTS smoke returned no usable audio bytes.");
}
const bytes = new Uint8Array(result.audio);
const riff = String.fromCharCode(...bytes.slice(0, 4)) === "RIFF";
const wave = String.fromCharCode(...bytes.slice(8, 12)) === "WAVE";
if (!riff || !wave) {
  throw new Error("Gemini TTS smoke did not return a RIFF/WAVE file.");
}

console.log(
  "Gemini TTS smoke passed: " + result.audio.byteLength +
  " bytes (" + result.mimeType + ") using model " + result.model + "."
);
