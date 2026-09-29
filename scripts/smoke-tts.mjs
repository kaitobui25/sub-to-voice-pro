import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const runtimePath = path.join(root, "runtime-config.local.json");
if (!fs.existsSync(runtimePath)) {
  throw new Error("Missing runtime-config.local.json. Run: npm run config");
}

const config = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
const tts = config.tts || {};
const require = createRequire(import.meta.url);

let provider;
if (tts.provider === "gemini") {
  const { createGeminiTTSProvider } = require("../lib/providers/gemini-tts.js");
  provider = createGeminiTTSProvider({
    apiKey: tts.apiKey,
    baseUrl: tts.baseUrl,
    models: tts.models,
    voice: tts.voice
  });
} else if (tts.provider === "vieneu") {
  const { createVieNeuTTSProvider } = require("../lib/providers/vieneu.js");
  provider = createVieNeuTTSProvider({
    apiKey: tts.apiKey,
    baseUrl: tts.baseUrl,
    model: tts.model,
    voice: tts.voice,
    sampleRate: tts.sampleRate
  });
} else {
  throw new Error("Unsupported configured TTS provider: " + tts.provider);
}

const result = await provider.synthesize({
  text: "Xin chào.",
  voice: tts.voice,
  speed: tts.speed == null ? 1 : tts.speed
});

const bytes = new Uint8Array(result.audio);
const header = Buffer.from(bytes.subarray(0, 12));
if (
  result.audio.byteLength < 44 ||
  header.toString("ascii", 0, 4) !== "RIFF" ||
  header.toString("ascii", 8, 12) !== "WAVE"
) {
  throw new Error("Configured TTS provider did not return a complete RIFF/WAVE response.");
}

console.log(
  "TTS smoke passed: " + result.audio.byteLength +
  " bytes (" + result.mimeType + ") using provider " + tts.provider +
  (result.model ? " / model " + result.model : "") + "."
);
