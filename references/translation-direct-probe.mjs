// Calls the production translation manager; no TTS or browser playback.
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const input = process.argv[2];
if (!input) throw new Error("Usage: node references/translation-direct-probe.mjs LOG.txt [OUTPUT.json]");
const output = path.resolve(process.argv[3] || "artifacts/translation-direct-probe.json");
const config = JSON.parse(await fs.readFile(path.join(repo, "runtime-config.local.json"), "utf8"));
const require = createRequire(import.meta.url);
require("../lib/translation-core.js");
require("../lib/providers/gemini.js");
const runtime = require("../lib/providers/runtime.js");
const rows = (await fs.readFile(path.resolve(input), "utf8")).replace(/^\uFEFF/, "")
  .split(/\r?\n(?=#\d+\s*\|)/).map(block => ({
    id: Number(block.match(/^#(\d+)\s*\|/)?.[1]),
    source: block.match(/^Câu đã xử lý:\s*(.*)$/m)?.[1]?.trim(),
    google: block.match(/^Bản dịch:\s*(.*)$/m)?.[1]?.trim()
  })).filter(row => Number.isInteger(row.id) && row.source);
if (!rows.length) throw new Error("No processed subtitle lines found.");
const report = { startedAt: new Date().toISOString(), input: path.resolve(input),
  models: config.translation.models, batchLimits: config.translation.batchLimits,
  rows, runs: [], note: "Same production manager and prompt; direct English-to-Vietnamese, no Google drafts sent, no TTS. One full excerpt per model-pool rotation." };
await fs.mkdir(path.dirname(output), { recursive: true });
for (let index = 0; index < config.translation.models.length; index++) {
  const attempts = [];
  const manager = runtime.createTranslationManager({ ...config.translation, provider: "gemini", fallbackProviders: [] },
    { onAttempt: attempt => attempts.push(attempt) });
  const start = performance.now();
  const run = { attempts };
  try {
    run.translations = await manager.translateBatch({ lines: rows.map(row => row.source), sourceLanguage: "en", targetLanguage: "vi" });
  } catch (error) {
    run.error = String(error.message).split(config.translation.apiKey).join("[redacted]");
  }
  run.totalMs = performance.now() - start;
  report.runs.push(run);
  await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ run: index + 1, lines: run.translations?.length, totalMs: Math.round(run.totalMs),
    attempts: attempts.map(a => ({ model: a.model, lineCount: a.lineCount, inputChars: a.inputChars, status: a.httpStatus, outcome: a.outcome })) }));
}
report.finishedAt = new Date().toISOString();
await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
const readable = report.rows.map((row, index) => [
  `#${row.id}\nEnglish: ${row.source}\nGoogle: ${row.google || ""}`,
  ...report.runs.map((run, round) => `Run ${round + 1} (${run.attempts.filter(a => a.outcome === "success").map(a => a.model).join(", ")}): ${run.translations?.[index] || run.error}`)
].join("\n")).join("\n\n");
await fs.writeFile(output.replace(/\.json$/i, "") + ".txt", readable + "\n");
console.log(`Saved direct translation comparison to ${output}`);
