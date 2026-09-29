import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createNovAIProvider } = require("../lib/providers/novai.js");
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const values = {};
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function assertAudioSignature(audio, mimeType) {
  const bytes = new Uint8Array(audio);
  if (mimeType === "audio/wav" || mimeType === "audio/x-wav") {
    const riff = bytes.length >= 12 &&
      String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
      String.fromCharCode(...bytes.slice(8, 12)) === "WAVE";
    if (!riff) throw new Error("NovAI smoke returned audio/wav without a RIFF/WAVE signature.");
    return;
  }

  if (mimeType === "audio/mpeg" || mimeType === "audio/mp3") {
    const id3 = bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
    const frameSync = bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
    if (!id3 && !frameSync) throw new Error("NovAI smoke returned MP3 mime without an MP3 signature.");
    return;
  }

  if (!mimeType.startsWith("audio/")) {
    throw new Error(`NovAI smoke returned non-audio mime type: ${mimeType}`);
  }
}

const localEnv = readEnvFile(path.join(rootDir, ".env"));
const apiKey = process.env.NOVAI_API_KEY || localEnv.NOVAI_API_KEY;
if (!apiKey) {
  throw new Error("NOVAI_API_KEY is missing from the process environment and root .env.");
}

const provider = createNovAIProvider({ apiKey });
const result = await provider.synthesize({
  text: "Xin chào Việt Nam.",
  speed: 1
});

if (!(result.audio instanceof ArrayBuffer) || result.audio.byteLength === 0) {
  throw new Error("NovAI smoke returned no audio bytes.");
}
assertAudioSignature(result.audio, result.mimeType);
console.log(`NovAI smoke passed: ${result.audio.byteLength} bytes (${result.mimeType}).`);
