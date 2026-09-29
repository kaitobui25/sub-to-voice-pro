(function initMicrosoftTranslateProvider(root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SubToVoiceMicrosoftTranslateProvider = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function microsoftTranslateFactory(root) {
  "use strict";

  function createMicrosoftTranslateProvider({ authUrl, baseUrl, tokenTtlMs, timeoutMs, fetchImpl } = {}) {
    if (!authUrl || !baseUrl) throw new Error("Microsoft Translator URLs are required.");
    const request = fetchImpl || root.fetch;
    let token = "";
    let tokenExpires = 0;

    async function timedFetch(url, options, signal) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const timer = setTimeout(abort, timeoutMs);
      try {
        return await request(url, { ...options, signal: controller.signal });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    }

    async function getToken(signal) {
      if (token && Date.now() < tokenExpires) return token;
      const response = await timedFetch(authUrl, {}, signal);
      if (!response.ok) throw new Error("Microsoft Translator auth HTTP " + response.status);
      token = (await response.text()).trim();
      if (!token) throw new Error("Microsoft Translator returned an empty token.");
      tokenExpires = Date.now() + tokenTtlMs;
      return token;
    }

    return {
      async translateBatch({ lines, sourceLanguage, targetLanguage, signal }) {
        const url = new URL(baseUrl);
        url.searchParams.set("api-version", "3.0");
        url.searchParams.set("to", targetLanguage === "zh" || targetLanguage === "zh-CN" ? "zh-Hans" : targetLanguage === "zh-TW" ? "zh-Hant" : targetLanguage);
        if (sourceLanguage && sourceLanguage !== "auto") url.searchParams.set("from", sourceLanguage);
        if (lines.some((line) => /<\/?[A-Za-z][^>]*>/.test(line))) url.searchParams.set("textType", "html");
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const bearer = await getToken(signal);
          const response = await timedFetch(url.toString(), {
            method: "POST",
            headers: { Authorization: "Bearer " + bearer, "Content-Type": "application/json; charset=UTF-8" },
            body: JSON.stringify(lines.map((line) => ({ Text: line })))
          }, signal);
          if ((response.status === 401 || response.status === 403) && attempt === 0) {
            token = "";
            continue;
          }
          if (!response.ok) throw new Error("Microsoft Translator HTTP " + response.status);
          const data = await response.json();
          if (!Array.isArray(data) || data.length !== lines.length) {
            throw new Error("Microsoft Translator returned an invalid batch.");
          }
          return data.map((item) => item?.translations?.[0]?.text);
        }
      }
    };
  }

  return { createMicrosoftTranslateProvider };
});
