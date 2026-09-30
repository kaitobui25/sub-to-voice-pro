"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { timestamp, format } = require("../lib/transcript-export.js");

test("TXT places each translated audio interval beneath its source sentence", () => {
  assert.equal(timestamp(600.9), "10:00:90");
  assert.equal(timestamp(3600.01), "01:00:00:01");
  assert.equal(format({ rows: [
    { originals: [
      { start: 600, end: 601, text: "Original" },
      { start: 601, end: 602, text: "sentence" }
    ], translation: "abc def xyz", audio: [
      { start: 600.9, end: 602.65, text: "abc def" },
      { start: 603.72, end: 604.85, text: "xyz" }
    ] },
    { originals: [{ start: 605, end: 606, text: "Not spoken" }], translation: "Đã dịch", audio: [] },
    { originals: [{ start: 607, end: 608, text: "Not translated" }], translation: null, audio: [] }
  ] }), "Phụ đề gốc:\n[10:00:00 ~ 10:01:00] Original\n[10:01:00 ~ 10:02:00] sentence\nBản dịch: abc def xyz\nAudio: [10:00:90 ~ 10:02:65] abc def, [10:03:72 ~ 10:04:85] xyz\n\nPhụ đề gốc:\n[10:05:00 ~ 10:06:00] Not spoken\nBản dịch: Đã dịch\nAudio: [Chưa phát]\n\nPhụ đề gốc:\n[10:07:00 ~ 10:08:00] Not translated\nBản dịch: [Chưa dịch]\nAudio: [Chưa phát]\n");
});
