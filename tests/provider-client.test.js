"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

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
