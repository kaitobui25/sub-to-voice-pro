(function initGoogleTranslateProvider(root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SubToVoiceGoogleTranslateProvider = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function googleTranslateFactory(root) {
  "use strict";

  const htmlEntities = {
    amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " "
  };

  function decodeHtmlEntities(value) {
    return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (entity, code) => {
      if (code[0] !== "#") return htmlEntities[code.toLowerCase()] ?? entity;
      const point = code[1]?.toLowerCase() === "x"
        ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point) : entity;
    });
  }

  function createGoogleTranslateProvider({ baseUrl, client, timeoutMs, fetchImpl } = {}) {
    if (!baseUrl || !client) throw new Error("Google Translate URL and client are required.");
    const request = fetchImpl || root.fetch;
    return {
      async translateBatch({ lines, sourceLanguage, targetLanguage, signal }) {
        const url = new URL(baseUrl);
        url.search = new URLSearchParams({
          client,
          dt: "t",
          sl: sourceLanguage || "auto",
          tl: targetLanguage,
          format: "html"
        }).toString();
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        const timer = setTimeout(abort, timeoutMs);
        try {
          const response = await request(url.toString(), {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: lines.map((line) => "q=" + encodeURIComponent(line)).join("&"),
            signal: controller.signal
          });
          if (!response.ok) throw new Error("Google Translate HTTP " + response.status);
          const data = await response.json();
          if (!Array.isArray(data) || data.length !== lines.length) {
            throw new Error("Google Translate returned an invalid batch.");
          }
          return data.map((item) => {
            while (Array.isArray(item)) item = item[0];
            return typeof item === "string" ? decodeHtmlEntities(item) : item;
          });
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        }
      }
    };
  }

  return { createGoogleTranslateProvider };
});
