import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  throw new Error(message);
}

function git(args, cwd = root) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function isTracked(relativePath) {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", relativePath], {
      cwd: root,
      stdio: "ignore"
    });
    return true;
  } catch {
    return false;
  }
}

function isIgnored(relativePath) {
  try {
    execFileSync("git", ["check-ignore", "--quiet", relativePath], {
      cwd: root,
      stdio: "ignore"
    });
    return true;
  } catch {
    return false;
  }
}

function parseEnv(text) {
  const values = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    values[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return values;
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

const manifest = JSON.parse(read("manifest.json"));
const permissions = new Set(manifest.permissions || []);
for (const required of ["scripting", "webRequest"]) {
  if (!permissions.has(required)) fail("Missing manifest permission: " + required);
}
if (permissions.has("activeTab")) {
  fail("activeTab is not needed for the current host-permission model.");
}

const example = parseEnv(read(".env.example"));
for (const key of ["GEMINI_API_KEY1", "GEMINI_API_KEY", "TTS_PROVIDER"]) {
  if (!(key in example)) fail(".env.example is missing " + key);
  if (example[key]) fail(".env.example must keep " + key + " blank.");
}

for (const sensitivePath of [".env", "runtime-config.local.json", "runtime-config.local.js"]) {
  if (isTracked(sensitivePath)) fail("Sensitive local file is tracked: " + sensitivePath);
}
for (const sensitivePath of [".env", "runtime-config.local.json"]) {
  if (!isIgnored(sensitivePath)) fail("Sensitive local file is not gitignored: " + sensitivePath);
}

const localEnvPath = path.join(root, ".env");
if (fs.existsSync(localEnvPath)) {
  const secrets = parseEnv(fs.readFileSync(localEnvPath, "utf8"));
  const trackedFiles = git(["ls-files"]).split(/\r?\n/).filter(Boolean);
  for (const [key, value] of Object.entries(secrets)) {
    if (!value || value.length < 8) continue;
    for (const relativePath of trackedFiles) {
      const absolutePath = path.join(root, relativePath);
      let text;
      try {
        text = fs.readFileSync(absolutePath, "utf8");
      } catch {
        continue;
      }
      if (text.includes(value)) {
        fail("A tracked file contains the configured value for " + key + ": " + relativePath);
      }
    }
  }
}

const coreFiles = [
  "background.js",
  "content.js",
  "lib/caption-core.js",
  "lib/playback-clock.js",
  "lib/playback-sync-controller.js",
  "lib/audio-scheduler.js",
  "lib/audio-preparation.js",
  "lib/provider-client.js",
  "lib/translation-core.js",
  "lib/tts-core.js"
];
const providerNames = /\b(?:gemini|vieneu)\b/i;
for (const relativePath of coreFiles) {
  if (providerNames.test(read(relativePath))) {
    fail("Provider-specific name leaked into core runtime file: " + relativePath);
  }
}

const forbiddenRuntimeApis = /MediaRecorder|RTCPeerConnection|getUserMedia|AudioWorklet|captureStream/;
for (const relativePath of coreFiles) {
  if (forbiddenRuntimeApis.test(read(relativePath))) {
    fail("Deferred architecture leaked into current MVP: " + relativePath);
  }
}

const playbackRateFiles = new Set([
  "lib/playback-sync-controller.js",
  "lib/audio-scheduler.js"
]);
for (const relativePath of coreFiles) {
  if (!playbackRateFiles.has(relativePath) && /\bplaybackRate\b/.test(read(relativePath))) {
    fail("playbackRate leaked outside the playback layer: " + relativePath);
  }
}

const configText = read("config.yaml");
function configSection(name) {
  return configText.split(new RegExp("^" + name + ":\\s*$", "m"))[1]
    ?.split(/^[A-Za-z_][\w-]*:\s*$/m)[0] || "";
}
const translationSection = configSection("translation");
const translationModelsBlock = translationSection.match(
  /^\s{2}models:\s*\r?\n((?:\s{4}-\s+\S+\s*(?:\r?\n|$))+)/m
)?.[1] || "";
const configuredTranslationModels = translationModelsBlock
  .split(/\r?\n/)
  .map((line) => line.match(/^\s{4}-\s+(\S+)\s*$/)?.[1])
  .filter(Boolean);
if (!configuredTranslationModels.length) {
  fail("config.yaml must define at least one translation.models entry.");
}
const geminiTTSSection = configSection("gemini_tts");
const ttsModelsBlock = geminiTTSSection.match(
  /^\s{2}models:\s*\r?\n((?:\s{4}-\s+\S+\s*(?:\r?\n|$))+)/m
)?.[1] || "";
const configuredTTSModels = ttsModelsBlock
  .split(/\r?\n/)
  .map((line) => line.match(/^\s{4}-\s+(\S+)\s*$/)?.[1])
  .filter(Boolean);
if (!configuredTTSModels.length) fail("config.yaml must define at least one gemini_tts.models entry.");
const vieneuModel = configSection("vieneu_tts").match(/^\s+model:\s*(\S+)\s*$/m)?.[1];
if (!vieneuModel) fail("config.yaml must define vieneu_tts.model.");
configuredTTSModels.push(vieneuModel);
const sourceFiles = git(["ls-files"])
  .split(/\r?\n/)
  .filter((relativePath) =>
    /\.(?:js|mjs)$/.test(relativePath) &&
    fs.existsSync(path.join(root, relativePath))
  );
for (const configuredModel of [...configuredTranslationModels, ...configuredTTSModels]) {
  for (const relativePath of sourceFiles) {
    if (read(relativePath).includes(configuredModel)) {
      fail("Configured provider model is hard-coded in source: " + relativePath);
    }
  }
}

const referenceRoot = path.resolve(root, "..", "references", "echoly");
if (fs.existsSync(path.join(referenceRoot, ".git"))) {
  const status = git(["status", "--porcelain"], referenceRoot);
  if (status) fail("Echoly reference repository has local changes.");
}

console.log("Release checks passed: permissions, secrets, provider boundary, deferred scope, reference cleanliness.");
