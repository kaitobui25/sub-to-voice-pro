"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TRANSLATION_BATCH_SIZE,
  TranslationProviderRegistry,
  TranslationManager,
  buildDubbingPrompt
} = require("../lib/translation-core.js");
const {
  createGeminiProvider,
  _resetModelStateForTests
} = require("../lib/providers/gemini.js");

test.beforeEach(() => {
  _resetModelStateForTests();
});

function makeManager(provider) {
  const registry = new TranslationProviderRegistry();
  registry.register("test", provider);
  return new TranslationManager({ registry, providerName: "test" });
}

test("translation manager keeps the locked batch size at 10", () => {
  assert.equal(TRANSLATION_BATCH_SIZE, 10);
});

test("buildDubbingPrompt preserves Echoly dubbing constraints", () => {
  const prompt = buildDubbingPrompt({
    lines: ["OpenAI ships tools."],
    sourceLanguage: "English",
    targetLanguage: "Vietnamese"
  });
  assert.match(prompt, /exactly 1 strings in the same order/);
  assert.match(prompt, /Preserve names, brand names, and technical terms verbatim/);
  assert.match(prompt, /prefer shorter natural phrasing/);
  assert.match(prompt, /from English to Vietnamese/);
});

test("translation manager sends 1 and 10 lines in one provider call", async () => {
  for (const count of [1, 10]) {
    const calls = [];
    const manager = makeManager({
      async translateBatch(request) {
        calls.push(request);
        return request.lines.map((line) => "translated:" + line);
      }
    });
    const lines = Array.from({ length: count }, (_, index) => "line-" + index);
    const output = await manager.translateBatch({
      lines,
      sourceLanguage: "English",
      targetLanguage: "Vietnamese"
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].lines.length, count);
    assert.deepEqual(output, lines.map((line) => "translated:" + line));
  }
});

test("translation manager batches more than 10 lines and preserves order", async () => {
  const batchSizes = [];
  const manager = makeManager({
    async translateBatch({ lines }) {
      batchSizes.push(lines.length);
      return lines.map((line) => "out:" + line);
    }
  });
  const lines = Array.from({ length: 23 }, (_, index) => "line-" + index);
  const output = await manager.translateBatch({
    lines,
    sourceLanguage: "English",
    targetLanguage: "Japanese"
  });
  assert.deepEqual(batchSizes, [10, 10, 3]);
  assert.deepEqual(output, lines.map((line) => "out:" + line));
});

test("translation manager rejects malformed and wrong-length provider output", async () => {
  const malformed = makeManager({ async translateBatch() { return { lines: [] }; } });
  await assert.rejects(
    malformed.translateBatch({ lines: ["a"], targetLanguage: "Vietnamese" }),
    /must return an array of strings/
  );

  const wrongLength = makeManager({ async translateBatch() { return ["only one"]; } });
  await assert.rejects(
    wrongLength.translateBatch({ lines: ["a", "b"], targetLanguage: "Vietnamese" }),
    /returned 1 lines for 2 inputs/
  );
});

test("translation manager rejects blank translated strings", async () => {
  const manager = makeManager({ async translateBatch() { return ["   "]; } });
  await assert.rejects(
    manager.translateBatch({ lines: ["a"], targetLanguage: "Vietnamese" }),
    /invalid string at index 0/
  );
});

test("translation manager falls back per batch and preserves line order", async () => {
  const calls = [];
  const registry = new TranslationProviderRegistry();
  registry.register("gemini", { async translateBatch({ lines }) {
    calls.push("gemini");
    if (lines[0] === "line-0") throw new Error("unavailable");
    return lines.map((line) => "gemini:" + line);
  } });
  registry.register("google", { async translateBatch({ lines }) {
    calls.push("google");
    return lines.map((line) => "google:" + line);
  } });
  const manager = new TranslationManager({ registry, providerName: "gemini", fallbackProviders: ["google"] });
  const lines = Array.from({ length: 11 }, (_, index) => "line-" + index);
  const output = await manager.translateBatch({ lines, targetLanguage: "vi" });
  assert.deepEqual(calls, ["gemini", "google", "gemini"]);
  assert.deepEqual(output, [...lines.slice(0, 10).map((line) => "google:" + line), "gemini:line-10"]);
});

test("translation manager continues after malformed fallback and stops on abort", async () => {
  const registry = new TranslationProviderRegistry();
  registry.register("gemini", { async translateBatch() { throw new Error("offline"); } });
  registry.register("google", { async translateBatch() { return [""]; } });
  registry.register("microsoft", { async translateBatch({ lines }) { return lines.map(() => "ok"); } });
  const manager = new TranslationManager({
    registry, providerName: "gemini", fallbackProviders: ["google", "microsoft"]
  });
  assert.deepEqual(await manager.translateBatch({ lines: ["hello"], targetLanguage: "vi" }), ["ok"]);
  const controller = new AbortController();
  registry.register("gemini", { async translateBatch() { controller.abort(); throw new Error("cancelled"); } });
  await assert.rejects(manager.translateBatch({ lines: ["hello"], targetLanguage: "vi", signal: controller.signal }), { name: "AbortError" });
});

test("translation manager honors AbortSignal before and between batches", async () => {
  const preAborted = new AbortController();
  preAborted.abort();
  let calls = 0;
  const manager = makeManager({
    async translateBatch({ lines }) {
      calls += 1;
      return lines;
    }
  });
  await assert.rejects(
    manager.translateBatch({
      lines: ["a"],
      targetLanguage: "Vietnamese",
      signal: preAborted.signal
    }),
    { name: "AbortError" }
  );
  assert.equal(calls, 0);

  const controller = new AbortController();
  const betweenBatches = makeManager({
    async translateBatch({ lines }) {
      calls += 1;
      controller.abort();
      return lines;
    }
  });
  await assert.rejects(
    betweenBatches.translateBatch({
      lines: Array.from({ length: 11 }, (_, index) => "line-" + index),
      targetLanguage: "Vietnamese",
      signal: controller.signal
    }),
    { name: "AbortError" }
  );
  assert.equal(calls, 1);
});

test("Gemini adapter owns endpoint, auth, request shape, and response parsing", async () => {
  let requestUrl = "";
  let requestOptions = null;
  const provider = createGeminiProvider({
    baseUrl: "https://example.test/v1beta/",
    apiKey: "test-secret",
    model: "gemini-test",
    fetchImpl: async (url, options) => {
      requestUrl = url;
      requestOptions = options;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            candidates: [{ content: { parts: [{ text: '{"lines":["Xin chao"]}' }] } }]
          };
        }
      };
    }
  });

  const output = await provider.translateBatch({ prompt: "PROMPT" });
  assert.deepEqual(output, ["Xin chao"]);
  assert.equal(
    requestUrl,
    "https://example.test/v1beta/models/gemini-test:generateContent"
  );
  assert.equal(requestOptions.method, "POST");
  assert.equal(requestOptions.headers["x-goog-api-key"], "test-secret");
  const body = JSON.parse(requestOptions.body);
  assert.equal(body.contents[0].parts[0].text, "PROMPT");
  assert.equal(body.generationConfig.responseMimeType, "application/json");
});

test("Gemini adapter rejects response JSON without a lines array", async () => {
  const provider = createGeminiProvider({
    baseUrl: "https://example.test/v1beta",
    apiKey: "test-secret",
    model: "gemini-test",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          candidates: [{ content: { parts: [{ text: '{"translation":"x"}' }] } }]
        };
      }
    })
  });
  await assert.rejects(
    provider.translateBatch({ prompt: "PROMPT" }),
    /must contain a lines array/
  );
});

test("Gemini adapter falls back to the next configured translation model on 429", async () => {
  const modelsSeen = [];
  const provider = createGeminiProvider({
    baseUrl: "https://example.test/v1beta",
    apiKey: "test-secret",
    models: ["models/primary-model", "fallback-model"],
    fetchImpl: async (url) => {
      const model = decodeURIComponent(url.match(/\/models\/([^:]+):generateContent$/)[1]);
      modelsSeen.push(model);
      if (model === "primary-model") {
        return {
          ok: false,
          status: 429,
          headers: { get: () => null },
          async text() {
            return JSON.stringify({
              error: { message: "Rate limit exceeded. Please retry in 13.8s." }
            });
          }
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            candidates: [{ content: { parts: [{ text: '{"lines":["Xin chao"]}' }] } }]
          };
        }
      };
    }
  });

  const output = await provider.translateBatch({ prompt: "PROMPT" });
  assert.deepEqual(output, ["Xin chao"]);
  assert.deepEqual(modelsSeen, ["primary-model", "fallback-model"]);
});

test("Gemini translation rotates configured models after successful batches", async () => {
  const seen = [];
  const provider = createGeminiProvider({
    baseUrl: "https://round-robin.test/v1beta", apiKey: "test-secret",
    models: ["model-a", "model-b"],
    fetchImpl: async (url) => {
      seen.push(decodeURIComponent(url.match(/\/models\/([^:]+):generateContent$/)[1]));
      return { ok: true, async json() {
        return { candidates: [{ content: { parts: [{ text: '{"lines":["xin"]}' }] } }] };
      } };
    }
  });
  await provider.translateBatch({ prompt: "first" });
  await provider.translateBatch({ prompt: "second" });
  await provider.translateBatch({ prompt: "third" });
  assert.deepEqual(seen, ["model-a", "model-b", "model-a"]);
});

test("Gemini adapter falls back to the next configured translation model on 503", async () => {
  const modelsSeen = [];
  const provider = createGeminiProvider({
    baseUrl: "https://service-unavailable.test/v1beta",
    apiKey: "test-secret",
    models: ["model-a", "model-b"],
    fetchImpl: async (url) => {
      const model = decodeURIComponent(url.match(/\/models\/([^:]+):generateContent$/)[1]);
      modelsSeen.push(model);
      if (model === "model-a") {
        return {
          ok: false,
          status: 503,
          headers: { get: () => null },
          async text() {
            return JSON.stringify({
              error: { message: "The service is currently unavailable." }
            });
          }
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            candidates: [{ content: { parts: [{ text: '{"lines":["ok"]}' }] } }]
          };
        }
      };
    }
  });

  assert.deepEqual(await provider.translateBatch({ prompt: "PROMPT" }), ["ok"]);
  assert.deepEqual(modelsSeen, ["model-a", "model-b"]);
});

test("Gemini adapter remembers 503 cooldown across provider instances", async () => {
  const modelsSeen = [];
  const options = {
    baseUrl: "https://service-cooldown.test/v1beta",
    apiKey: "test-secret",
    models: ["model-a", "model-b"],
    fetchImpl: async (url) => {
      const model = decodeURIComponent(url.match(/\/models\/([^:]+):generateContent$/)[1]);
      modelsSeen.push(model);
      if (model === "model-a") {
        return {
          ok: false,
          status: 503,
          headers: { get: () => null },
          async text() { return "temporarily unavailable"; }
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            candidates: [{ content: { parts: [{ text: '{"lines":["ok"]}' }] } }]
          };
        }
      };
    }
  };

  const first = createGeminiProvider(options);
  assert.deepEqual(await first.translateBatch({ prompt: "ONE" }), ["ok"]);
  assert.deepEqual(modelsSeen, ["model-a", "model-b"]);

  const second = createGeminiProvider(options);
  assert.deepEqual(await second.translateBatch({ prompt: "TWO" }), ["ok"]);
  assert.deepEqual(modelsSeen, ["model-a", "model-b", "model-b"]);
});

test("Gemini adapter remembers translation model cooldown across provider instances", async () => {
  const modelsSeen = [];
  const options = {
    baseUrl: "https://cooldown.test/v1beta",
    apiKey: "test-secret",
    models: ["primary-model", "fallback-model"],
    fetchImpl: async (url) => {
      const model = decodeURIComponent(url.match(/\/models\/([^:]+):generateContent$/)[1]);
      modelsSeen.push(model);
      if (model === "primary-model") {
        return {
          ok: false,
          status: 429,
          headers: { get: () => "30" },
          async text() { return "rate limited"; }
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            candidates: [{ content: { parts: [{ text: '{"lines":["ok"]}' }] } }]
          };
        }
      };
    }
  };

  const first = createGeminiProvider(options);
  assert.deepEqual(await first.translateBatch({ prompt: "ONE" }), ["ok"]);
  assert.deepEqual(modelsSeen, ["primary-model", "fallback-model"]);

  const second = createGeminiProvider(options);
  assert.deepEqual(await second.translateBatch({ prompt: "TWO" }), ["ok"]);
  assert.deepEqual(modelsSeen, ["primary-model", "fallback-model", "fallback-model"]);
});

test("Gemini adapter makes no translation request while all configured models are cooling down", async () => {
  const calls = [];
  const options = {
    baseUrl: "https://all-limited.test/v1beta",
    apiKey: "test-secret",
    models: ["model-a", "model-b"],
    fetchImpl: async (url) => {
      calls.push(url);
      return {
        ok: false,
        status: 429,
        headers: { get: () => "20" },
        async text() { return "rate limited"; }
      };
    }
  };

  const first = createGeminiProvider(options);
  await assert.rejects(first.translateBatch({ prompt: "ONE" }), /rate-limited.*20s/i);
  assert.equal(calls.length, 2);

  const second = createGeminiProvider({
    ...options,
    fetchImpl: async () => {
      calls.push("unexpected");
      throw new Error("must not call");
    }
  });
  await assert.rejects(second.translateBatch({ prompt: "TWO" }), /rate-limited.*20s/i);
  assert.equal(calls.length, 2);
});

test("Gemini adapter does not switch translation models on non-transient client errors", async () => {
  const modelsSeen = [];
  const provider = createGeminiProvider({
    baseUrl: "https://example.test/v1beta",
    apiKey: "test-secret",
    models: ["model-a", "model-b"],
    fetchImpl: async (url) => {
      modelsSeen.push(url);
      return {
        ok: false,
        status: 400,
        async text() { return "bad request"; }
      };
    }
  });

  await assert.rejects(provider.translateBatch({ prompt: "PROMPT" }), /HTTP 400/);
  assert.equal(modelsSeen.length, 1);
});
