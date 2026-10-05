"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("provider client forwards source context and preserves attempt logs on success and error", async () => {
  const attempt = { model: "test", httpStatus: 503, errorType: "http" };
  let failed = false;
  global.chrome = { runtime: { lastError: null, sendMessage(message, callback) {
    assert.deepEqual(message.context, ["previous"]);
    callback(failed ? { ok: false, error: "unavailable", attempts: [attempt] }
      : { ok: true, lines: ["translated"], attempts: [attempt] });
  } } };
  delete require.cache[require.resolve("../lib/provider-client.js")];
  const client = require("../lib/provider-client.js");
  try {
    const seen = [];
    assert.deepEqual(await client.translateBatch({ lines: ["source"], context: ["previous"], onAttempt: row => seen.push(row) }), ["translated"]);
    assert.deepEqual(seen, [attempt]);
    failed = true;
    await assert.rejects(client.translateBatch({ lines: ["source"], context: ["previous"] }), error => {
      assert.deepEqual(error.attempts, [attempt]);
      return true;
    });
  } finally { delete global.chrome; delete global.SubToVoiceProviderClient; }
});

test("provider client abort sends cancellation and ignores a late provider reply", async () => {
  const messages = [];
  let translateCallback = null;
  global.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        messages.push(message);
        if (message.type === "TRANSLATE_BATCH") {
          translateCallback = callback;
          return undefined;
        }
        if (typeof callback === "function") callback({ ok: true });
        return Promise.resolve({ ok: true });
      }
    }
  };

  delete require.cache[require.resolve("../lib/provider-client.js")];
  const client = require("../lib/provider-client.js");
  const controller = new AbortController();
  const pending = client.translateBatch({
    lines: ["hello"],
    sourceLanguage: "en",
    targetLanguage: "vi",
    signal: controller.signal
  });

  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(messages[0].type, "TRANSLATE_BATCH");
  assert.equal(messages[1].type, "CANCEL_PROVIDER_REQUEST");
  assert.equal(messages[1].requestId, messages[0].requestId);

  translateCallback({ ok: true, lines: ["late"] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.length, 2);

  delete global.chrome;
  delete global.SubToVoiceProviderClient;
});
