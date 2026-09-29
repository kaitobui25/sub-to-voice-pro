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

test("ASR uses segment offsets and joins fragments until punctuation", () => {
  const events = [
    { tStartMs: 1000, dDurationMs: 900, segs: [{ utf8: "Well", tOffsetMs: 0 }, { utf8: " uh,", tOffsetMs: 300 }] },
    { tStartMs: 1900, dDurationMs: 700, segs: [{ utf8: " welcome", tOffsetMs: 0 }, { utf8: " back.", tOffsetMs: 350 }] }
  ];
  assert.deepEqual(parseJson3Events(events, { isAsr: true }), [
    { start: 1, end: 2.6, text: "Well uh, welcome back." }
  ]);
});

test("ASR dedupes rolling overlap and splits after a long pause", () => {
  const events = [
    { tStartMs: 0, dDurationMs: 800, segs: [{ utf8: "hello world" }] },
    { tStartMs: 800, dDurationMs: 800, segs: [{ utf8: "world again" }] },
    { tStartMs: 5200, dDurationMs: 800, segs: [{ utf8: "um, next" }] }
  ];
  assert.deepEqual(parseJson3Events(events, { isAsr: true }).map((cue) => cue.text), [
    "hello world again", "um, next"
  ]);
});

test("ASR trims rolling display overlap and removes bracketed noise", () => {
  const cues = parseJson3Events([
    { tStartMs: 0, dDurationMs: 4000, segs: [{ utf8: "[Music] Welcome", tOffsetMs: 0 }] },
    { tStartMs: 800, dDurationMs: 1000, segs: [{ utf8: " back.", tOffsetMs: 0 }] },
    { tStartMs: 1800, dDurationMs: 500, segs: [{ utf8: "[Applause] ♪" }] }
  ], { isAsr: true });
  assert.deepEqual(cues, [{ start: 0, end: 1.8, text: "Welcome back." }]);
});

test("ASR long block prefers a natural split and keeps timing ordered", () => {
  const words = "We looked at the first result, and then we carefully compared the second result because the numbers changed after another long pause in the recording";
  const events = [{ tStartMs: 0, dDurationMs: 16000, segs: words.split(" ").map((utf8, index) => ({ utf8, tOffsetMs: index * 650 })) }];
  const cues = parseJson3Events(events, { isAsr: true });
  assert.ok(cues.length >= 2);
  assert.match(cues[0].text, /,$/);
  assert.equal(cues.map((cue) => cue.text).join(" "), words);
  assert.ok(cues.every((cue) => cue.end > cue.start));
});

test("non-speech cues are removed before translation while spoken fillers remain", () => {
  const events = [
    { tStartMs: 0, dDurationMs: 500, segs: [{ utf8: "[Music]" }] },
    { tStartMs: 500, dDurationMs: 500, segs: [{ utf8: "[Applause]" }] },
    { tStartMs: 1000, dDurationMs: 500, segs: [{ utf8: "[Laughter]" }] },
    { tStartMs: 1500, dDurationMs: 500, segs: [{ utf8: "♪ <b>um</b> [Music] Welcome back" }] }
  ];
  assert.deepEqual(regroupToSentences(parseJson3Events(events)), [
    { start: 1.5, end: 2, text: "um Welcome back" }
  ]);
});

test("speaker markers are removed before translation", () => {
  const events = [
    { tStartMs: 0, dDurationMs: 900, segs: [{ utf8: "um how you make money >> actually" }] },
    { tStartMs: 1000, dDurationMs: 600, segs: [{ utf8: ">> oh my god" }] }
  ];
  assert.deepEqual(parseJson3Events(events).map((cue) => cue.text), [
    "um how you make money actually", "oh my god"
  ]);
  assert.deepEqual(parseJson3Events(events, { isAsr: true }).map((cue) => cue.text), [
    "um how you make money actually oh my god"
  ]);
});
