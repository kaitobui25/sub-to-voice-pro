"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { timestamp, format } = require("../lib/transcript-export.js");

test("TXT places each translated audio interval beneath its source sentence", () => {
  assert.equal(timestamp(600.9), "10:00:90");
  assert.equal(timestamp(3600.01), "01:00:00:01");
  assert.equal(format({ rows: [
    { source: "Original sentence", audio: [
      { start: 600.9, end: 602.65, text: "abc def" },
      { start: 603.72, end: 604.85, text: "xyz" }
    ] },
    { source: "Not spoken", audio: [] }
  ] }), "Original sentence\n[10:00:90 ~ 10:02:65] abc def, [10:03:72 ~ 10:04:85] xyz\n");
});
