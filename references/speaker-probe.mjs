import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const input = path.resolve(process.argv[2] || "../log/sub-to-voice-1_iNTFSw4Nc.txt");
const output = path.resolve(process.argv[3] || `artifacts/speaker-probe-${path.basename(input, ".txt")}.json`);
const dryRun = process.argv.includes("--dry-run");
const chunkSize = 35;
const contextSize = 8;

function readLines(text) {
  return text.replace(/^\uFEFF/, "").split(/\r?\n\s*\r?\n/).map((block) => {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return lines.find((line) => !/^\[\d{2}:\d{2}:\d{2}/.test(line));
  }).filter(Boolean).map((text, index) => ({ id: index + 1, text }));
}

function promptFor(chunk, context) {
  return `You are labeling speakers in an English podcast transcript. Use only the text below. Do not translate or rewrite it.

Stable labels:
S1 = Andrew Huberman, the host. He introduces himself as Andrew, thanks Oded for joining, and normally asks the questions.
S2 = Oded, the guest. He replies "Totally my pleasure" near the opening and normally explains his research.
U = unclear from the text. Do not guess merely because a line is next to another line; short fragments can continue across a speaker turn.

The caption lines are imperfect ASR fragments. A single line may contain both speakers or a cut through a sentence. For a mixed line choose U and flag it in notes. Keep S1/S2 identities consistent across chunks. Use conversational roles, first-person references, direct address, and adjacent context as evidence. Distinguish confidence: high, medium, low. When evidence is weak, use U.

Previous labeled context (do not repeat these IDs in output):
${JSON.stringify(context)}

Assign exactly one label to every ID here:
${JSON.stringify(chunk)}

Return only JSON: {"assignments":[{"id":1,"speaker":"S1|S2|U","confidence":"high|medium|low"}],"notes":[{"ids":[1],"reason":"brief evidence or ambiguity"}]}. Include notes only for uncertain or mixed turns. Do not omit or add IDs.`;
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
    if (!["S1", "S2", "U"].includes(value.speaker)) throw new Error(`Invalid speaker at ${item.id}.`);
    return { ...item, speaker: value.speaker, confidence: value.confidence || "low" };
  });
}

const lines = readLines(await fs.readFile(input, "utf8"));
if (!lines.length) throw new Error("No processed English lines found in " + input);
const config = JSON.parse(await fs.readFile(path.join(repo, "runtime-config.local.json"), "utf8")).translation;
if (!config?.apiKey || !config?.models?.length) throw new Error("Run npm run config with a Gemini key first.");

let results = [];
let chunks = [];
if (!dryRun) {
  const previous = await fs.readFile(output, "utf8").then(JSON.parse).catch(() => null);
  if (previous?.input === input && Array.isArray(previous.lines) && Array.isArray(previous.chunks)) {
    results = previous.lines;
    chunks = previous.chunks;
  }
}
for (let start = results.length; start < lines.length; start += chunkSize) {
  const chunk = lines.slice(start, start + chunkSize);
  const context = results.slice(-contextSize);
  const prompt = promptFor(chunk, context);
  if (dryRun) {
    process.stdout.write(prompt + "\n");
    break;
  }
  const { model, data } = await askGemini(prompt, config);
  const assigned = validate(data, chunk);
  results.push(...assigned);
  chunks.push({ firstId: chunk[0].id, lastId: chunk.at(-1).id, model, notes: data.notes || [] });
  process.stdout.write(`${chunk[0].id}-${chunk.at(-1).id}: ${model}\n`);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify({ input, speakers: { S1: "Andrew Huberman", S2: "Oded", U: "unclear" }, chunks, lines: results }, null, 2) + "\n");
}

if (!dryRun) {
  const readable = results.map((item) =>
    `[${String(item.id).padStart(3, "0")}] ${item.speaker} ${item.confidence}: ${item.text}`
  ).join("\n") + "\n";
  await fs.writeFile(output.replace(/\.json$/i, ".txt"), readable);
  process.stdout.write(`Saved ${results.length} labels to ${output}\n`);
}
