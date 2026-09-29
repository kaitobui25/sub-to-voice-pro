"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createGoogleTranslateProvider } = require("../lib/providers/google-translate.js");
const { createMicrosoftTranslateProvider } = require("../lib/providers/microsoft-translate.js");

test("Google adapter posts ordered lines with configured endpoint and language", async () => {
  let seen;
  const provider = createGoogleTranslateProvider({
    baseUrl: "https://example.test/translate", client: "gtx", timeoutMs: 1000,
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return { ok: true, async json() { return [["xin"], ["chào"]]; } };
    }
  });
  assert.deepEqual(await provider.translateBatch({ lines: ["hi", "hello"], sourceLanguage: "en", targetLanguage: "vi" }), ["xin", "chào"]);
  assert.equal(new URL(seen.url).searchParams.get("tl"), "vi");
  assert.equal(seen.options.body, "q=hi&q=hello");
});

test("Microsoft adapter obtains token and retries once after expired authorization", async () => {
  const calls = [];
  const provider = createMicrosoftTranslateProvider({
    authUrl: "https://example.test/auth", baseUrl: "https://example.test/translate",
    tokenTtlMs: 1000, timeoutMs: 1000,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/auth")) return { ok: true, async text() { return "token"; } };
      if (calls.filter((call) => call.url.includes("/translate")).length === 1) return { ok: false, status: 401 };
      return { ok: true, async json() { return [{ translations: [{ text: "xin" }] }]; } };
    }
  });
  assert.deepEqual(await provider.translateBatch({ lines: ["hi"], sourceLanguage: "en", targetLanguage: "vi" }), ["xin"]);
  assert.equal(calls.filter((call) => call.url.endsWith("/auth")).length, 2);
  assert.equal(JSON.parse(calls[1].options.body)[0].Text, "hi");
});
