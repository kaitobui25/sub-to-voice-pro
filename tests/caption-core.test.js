"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseJson3Events,
  mergeWithDedupe,
  regroupToSentences
} = require("../lib/caption-core.js");

test("parseJson3Events returns ordered caption cues", () => {
  const events = [
    { tStartMs: 1000, dDurationMs: 500, segs: [{ utf8: "Hello " }, { utf8: "world" }] },
    { tStartMs: 2200, dDurationMs: 300, segs: [{ utf8: "again" }] }
  ];
  assert.deepEqual(parseJson3Events(events), [
    { start: 1, end: 1.5, text: "Hello world" },
    { start: 2.2, end: 2.5, text: "again" }
  ]);
});

test("mergeWithDedupe removes sliding ASR overlap", () => {
  assert.equal(
    mergeWithDedupe("the world how", "world how are you"),
    "the world how are you"
  );
});

test("regroupToSentences joins short cues and preserves sentence boundaries", () => {
  const input = [
    { start: 0, end: 0.5, text: "Hello" },
    { start: 0.6, end: 1.0, text: "world." },
    { start: 1.1, end: 1.4, text: "Next" },
    { start: 1.5, end: 2.0, text: "line" }
  ];
  assert.deepEqual(regroupToSentences(input), [
    { start: 0, end: 1, text: "Hello world." },
    { start: 1.1, end: 2, text: "Next line" }
  ]);
});

test("regroupToSentences splits on a gap greater than 1500ms", () => {
  const input = [
    { start: 0, end: 0.5, text: "Before" },
    { start: 2.1, end: 2.5, text: "After" }
  ];
  assert.equal(regroupToSentences(input).length, 2);
});

test("regroupToSentences splits once the accumulated line reaches 15 words", () => {
  const fifteenWords = Array.from({ length: 15 }, (_, index) => "w" + index).join(" ");
  const result = regroupToSentences([
    { start: 0, end: 1, text: fifteenWords },
    { start: 1.1, end: 1.4, text: "next" }
  ]);
  assert.equal(result.length, 2);
});
