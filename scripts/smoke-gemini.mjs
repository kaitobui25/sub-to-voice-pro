import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const runtimePath = path.join(root, "runtime-config.local.json");
if (!fs.existsSync(runtimePath)) {
  throw new Error("Missing runtime-config.local.json. Run: npm run config");
}

const config = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
const translation = config.translation || {};
if (translation.provider !== "gemini") {
  throw new Error("Configured translation provider is not Gemini.");
}

const require = createRequire(import.meta.url);
const {
  TranslationProviderRegistry,
  TranslationManager
} = require("../lib/translation-core.js");
const { createGeminiProvider } = require("../lib/providers/gemini.js");

const provider = createGeminiProvider({
  apiKey: translation.apiKey,
  baseUrl: translation.baseUrl,
  models: translation.models
});
const registry = new TranslationProviderRegistry();
registry.register("gemini", provider);
const manager = new TranslationManager({ registry, providerName: "gemini" });

const output = await manager.translateBatch({
  lines: ["Hello.", "Thank you."],
  sourceLanguage: "English",
  targetLanguage: translation.targetLanguage || "Vietnamese"
});

console.log(
  "Gemini translation smoke passed: " + output.length +
  " lines using configured model fallback chain."
);
output.forEach((line, index) => console.log((index + 1) + ". " + line));
