"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { timestamp, format } = require("../lib/transcript-export.js");

test("TXT follows original, processed English, translation, audio order", () => {
  assert.equal(timestamp(600.9), "10:00:90");
  assert.equal(timestamp(3600.01), "01:00:00:01");
  const result = format({ rows: [
    {
      originals: [
        { start: 600, end: 601, text: "Original" },
        { start: 601, end: 602, text: "sentence" }
      ],
      processed: "Original sentence",
      translation: "Câu đã dịch",
      audio: [
        { start: 600.9, end: 602.65, text: "Câu đã dịch" },
        { start: 603.72, end: 604.85, text: "đoạn tiếp" }
      ]
    },
    {
      originals: [{ start: 605, end: 606, text: "[Music]" }],
      processed: null,
      translation: null,
      audio: []
    }
  ] });
  assert.equal(result, [
    "Phụ đề gốc:",
    "[10:00:00 ~ 10:01:00] Original",
    "[10:01:00 ~ 10:02:00] sentence",
    "Câu đã xử lý: Original sentence",
    "Bản dịch: Câu đã dịch",
    "Audio: [10:00:90 ~ 10:02:65] Câu đã dịch, [10:03:72 ~ 10:04:85] đoạn tiếp",
    "",
    "Phụ đề gốc:",
    "[10:05:00 ~ 10:06:00] [Music]",
    "Câu đã xử lý: [Không có]",
    "Bản dịch: [Chưa dịch]",
    "Audio: [Chưa phát]",
    ""
  ].join("\n"));
});

test("TXT explains why a translated sentence has no audio", () => {
  const result = format({ rows: [{
    id: 142, start: 1604.48, originals: [], processed: "Example",
    translation: "Ví dụ", audio: [], diagnostic: {
      translationStart: 0, translationEnd: 0.8,
      speakerStart: 0, speakerEnd: 12.6, speaker: "S2",
      ttsStart: 12.7, ttsEnd: 16.1,
      waitStart: 12.8, waitEnd: 16.2,
      schedule: { status: "late", lateBy: 11.4, limit: 0.5, videoTime: 1615.88 }
    }
  }] });
  assert.match(result, /#142 \| video 26:44:48/);
  assert.match(result, /Speaker: S2, xong \+12\.60s/);
  assert.match(result, /TTS: bắt đầu \+12\.70s, xong \+16\.10s/);
  assert.match(result, /Chờ audio: bắt đầu \+12\.80s, tiếp tục \+16\.20s \(3\.40s\)/);
  assert.match(result, /Xếp lịch: bỏ qua — câu đã trễ 11\.40s \(giới hạn 0\.50s/);
  assert.match(result, /Audio: \[Chưa phát\]/);
});
