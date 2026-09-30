import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inputArg = process.argv[2];
if (!inputArg || inputArg.startsWith("--")) throw new Error("Usage: node references/speaker-probe.mjs INPUT.txt [OUTPUT.json] [--dry-run]");
const input = path.resolve(inputArg);
const output = path.resolve(process.argv[3] && !process.argv[3].startsWith("--")
  ? process.argv[3] : `artifacts/speaker-probe-${path.basename(input, ".txt")}.json`);
const dryRun = process.argv.includes("--dry-run");
const chunkSize = 35;
const contextSize = 8;
const promptVersion = 2;

function readLines(text) {
  return text.replace(/^\uFEFF/, "").split(/\r?\n\s*\r?\n/).map((block) => {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const processed = lines.find((line) => line.startsWith("Câu đã xử lý:"));
    if (processed) {
      const value = processed.slice("Câu đã xử lý:".length).trim();
      return value === "[Không có]" ? null : value;
    }
    return lines.find((line) => !/^\[\d{2}:\d{2}:\d{2}/.test(line));
  }).filter(Boolean).map((text, index) => ({ id: index + 1, text }));
}

function promptFor(chunk, context, profiles) {
  return `You are identifying speakers from processed English subtitle text. You have no information about the video, its participants, names, topic, or number of speakers. Use only the supplied lines. Do not translate or rewrite them.

Stable labels:
S1 = the first distinct speaker identifiable in this excerpt. S2 = the next distinct speaker, S3 = the next, and so on. Never renumber labels. Do not assume there are exactly two speakers.
U = unclear, including a line containing multiple speakers or a fragment whose speaker cannot be inferred reliably.

The lines are imperfect ASR fragments. A question does not automatically imply a new speaker; quoted speech is not a speaker turn. A short acknowledgment such as "right" or "okay" is U unless surrounding text gives strong evidence. Use turn-taking, first-person continuity, direct address, and adjacent context. Keep labels consistent across chunks. Be conservative: when the text does not distinguish voices, choose U instead of guessing. Confidence is high, medium, or low.

Speaker profiles inferred from earlier chunks (do not invent identities):
${JSON.stringify(profiles)}

Previous labeled context (do not repeat these IDs in output):
${JSON.stringify(context)}

Assign exactly one label to every ID here:
${JSON.stringify(chunk)}

Return only JSON: {"assignments":[{"id":1,"speaker":"S1|S2|S3|U","confidence":"high|medium|low"}],"profiles":{"S1":"brief text-based role/style clue"},"notes":[{"ids":[1],"reason":"brief evidence or ambiguity"}]}. Include notes only for uncertain or mixed turns. Do not omit or add IDs.`;
}

function parseGemini(payload) {
  const text = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
  const parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  return Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
}

async function askGemini(prompt, config) {
  const failures = [];
  for (const model of config.models) {
    const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/models/${encodeURIComponent(model.replace(/^models\//, ""))}:generateContent`;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": config.apiKey },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, responseMimeType: "application/json", maxOutputTokens: 8192 }
        }),
        signal: AbortSignal.timeout(90000)
      });
      if (!response.ok) {
        failures.push(`${model}: HTTP ${response.status}`);
        continue;
      }
      return { model, data: parseGemini(await response.json()) };
    } catch (error) {
      failures.push(`${model}: ${error.message}`);
    }
  }
  throw new Error("No configured Gemini model returned usable JSON: " + failures.join("; "));
}

function validate(data, chunk) {
  const assignments = data?.assignments;
  if (!Array.isArray(assignments) || assignments.length !== chunk.length) {
    throw new Error(`Expected ${chunk.length} assignments, received ${assignments?.length ?? "none"}: ${JSON.stringify(data).slice(0, 500)}`);
  }
  const byId = new Map(assignments.map((item) => [item.id, item]));
  if (byId.size !== chunk.length || chunk.some((item) => !byId.has(item.id))) {
    throw new Error("Gemini omitted or duplicated a caption ID.");
  }
  return chunk.map((item) => {
    const value = byId.get(item.id);
    if (!/^S[1-9]\d*$/.test(value.speaker) && value.speaker !== "U") throw new Error(`Invalid speaker at ${item.id}.`);
    return { ...item, speaker: value.speaker, confidence: value.confidence || "low" };
  });
}

const lines = readLines(await fs.readFile(input, "utf8"));
if (!lines.length) throw new Error("No processed English lines found in " + input);
const config = JSON.parse(await fs.readFile(path.join(repo, "runtime-config.local.json"), "utf8")).translation;
if (!config?.apiKey || !config?.models?.length) throw new Error("Run npm run config with a Gemini key first.");

let results = [];
let chunks = [];
let profiles = {};
if (!dryRun) {
  const previous = await fs.readFile(output, "utf8").then(JSON.parse).catch(() => null);
  if (previous?.input === input && previous.promptVersion === promptVersion &&
      Array.isArray(previous.lines) && Array.isArray(previous.chunks)) {
    results = previous.lines;
    chunks = previous.chunks;
    profiles = previous.profiles || {};
  }
}
for (let start = results.length; start < lines.length; start += chunkSize) {
  const chunk = lines.slice(start, start + chunkSize);
  const context = results.slice(-contextSize);
  const prompt = promptFor(chunk, context, profiles);
  if (dryRun) {
    process.stdout.write(prompt + "\n");
    break;
  }
  const { model, data } = await askGemini(prompt, config);
  const assigned = validate(data, chunk);
  results.push(...assigned);
  profiles = { ...profiles, ...(data.profiles || {}) };
  chunks.push({ firstId: chunk[0].id, lastId: chunk.at(-1).id, model, notes: data.notes || [] });
  process.stdout.write(`${chunk[0].id}-${chunk.at(-1).id}: ${model}\n`);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify({ input, promptVersion, profiles, chunks, lines: results }, null, 2) + "\n");
}

if (!dryRun) {
  const readable = results.map((item) =>
    `[${String(item.id).padStart(3, "0")}] ${item.speaker} ${item.confidence}: ${item.text}`
  ).join("\n") + "\n";
  await fs.writeFile(output.replace(/\.json$/i, ".txt"), readable);
  process.stdout.write(`Saved ${results.length} labels to ${output}\n`);
}
