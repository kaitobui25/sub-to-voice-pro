import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
  TranslationProviderRegistry,
  TranslationManager
} = require("../lib/translation-core.js");
const { createGeminiProvider } = require("../lib/providers/gemini.js");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const envPath = path.join(projectRoot, ".env");

function parseEnv(text) {
  const values = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.replace(/^\uFEFF/, "");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function redact(text, secret) {
  const value = String(text || "");
  return secret ? value.split(secret).join("[redacted]") : value;
}

function readLocalEnv() {
  if (!fs.existsSync(envPath)) {
    throw new Error("Root .env is missing.");
  }
  return parseEnv(fs.readFileSync(envPath, "utf8"));
}

async function main() {
  const localEnv = readLocalEnv();
  const apiKey = process.env.GEMINI_API_KEY || localEnv.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is missing from environment/root .env.");

  const baseUrl = process.env.GEMINI_BASE_URL || localEnv.GEMINI_BASE_URL ||
    "https://generativelanguage.googleapis.com/v1beta";
  const model = process.env.GEMINI_MODEL || localEnv.GEMINI_MODEL || "gemini-2.5-flash";
  const targetLanguage = process.env.GEMINI_SMOKE_TARGET_LANGUAGE ||
    localEnv.GEMINI_SMOKE_TARGET_LANGUAGE || "Vietnamese";

  const registry = new TranslationProviderRegistry();
  registry.register("gemini", createGeminiProvider({ baseUrl, apiKey, model }));
  const manager = new TranslationManager({ registry, providerName: "gemini" });
  const input = ["Hello.", "Thank you."];
  const output = await manager.translateBatch({
    lines: input,
    sourceLanguage: "English",
    targetLanguage
  });

  console.log("Gemini smoke OK: " + output.length + " lines using model " + model + ".");
  output.forEach((line, index) => console.log((index + 1) + ". " + line));
}

try {
  await main();
} catch (error) {
  let localKey = "";
  try {
    localKey = process.env.GEMINI_API_KEY || readLocalEnv().GEMINI_API_KEY || "";
  } catch {
    localKey = process.env.GEMINI_API_KEY || "";
  }
  const message = error && error.message ? error.message : error;
  console.error("Gemini smoke FAILED: " + redact(message, localKey));
  process.exitCode = 1;
}
