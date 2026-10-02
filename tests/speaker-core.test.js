"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildPrompt, parseLabels, voiceForSpeaker } = require("../lib/speaker-core.js");

test("speaker prompt has numbered lines and requests only ID-label pairs", () => {
  const lines = [{ id: 5, text: "What do you think?" }, { id: 6, text: "I agree." }];
  const prompt = buildPrompt(lines, [{ id: 4, text: "Earlier.", speaker: "S1" }]);
  assert.match(prompt, /S3/);
  assert.match(prompt, /5/);
  assert.match(prompt, /Previous labeled context/);
  assert.match(prompt, /beginning and intro/i);
  assert.match(prompt, /host\/guest roles/i);
  assert.match(prompt, /Assign S1 to the first distinguishable speaker/i);
  assert.doesNotMatch(prompt, /male voices|female voices|gender/i);
  assert.doesNotMatch(prompt, /You do not know the video/i);
  assert.deepEqual(parseLabels(["5 S1", "6 S2"], lines), ["S1", "S2"]);
  assert.throws(() => parseLabels(["6 S1", "5 S2"], lines), /Invalid speaker label/);
});

test("configured VieNeu voices alternate by speaker while unknown labels use the default", () => {
  const voices = ["Male voice", "Female voice"];
  assert.equal(voiceForSpeaker("S1", voices, "default"), "Male voice");
  assert.equal(voiceForSpeaker("S2", voices, "default"), "Female voice");
  assert.equal(voiceForSpeaker("S3", voices, "default"), "Male voice");
  assert.equal(voiceForSpeaker("S4", voices, "default"), "Female voice");
  assert.equal(voiceForSpeaker("S5", voices, "default"), "Male voice");
  assert.equal(voiceForSpeaker("U", voices, "default"), "default");
});
