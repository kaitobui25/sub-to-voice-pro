(function initCaptionCore(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SubToVoiceCaptionCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function captionCoreFactory() {
  "use strict";

  const REGROUP_GAP_MS = 1500;
  const REGROUP_MAX_WORDS = 15;

  function parseJson3Events(events) {
    const out = [];
    for (const event of Array.isArray(events) ? events : []) {
      if (!event || !event.segs || typeof event.tStartMs !== "number") continue;
      const text = event.segs
        .map((segment) => segment.utf8 || "")
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      if (!text || text === "\n") continue;
      const start = event.tStartMs / 1000;
      const duration = (event.dDurationMs || 0) / 1000;
      out.push({ start, end: start + duration, text });
    }
    return out;
  }

  function mergeWithDedupe(aText, bText) {
    const left = String(aText || "");
    const aTokens = left.split(/\s+/).filter(Boolean);
    const bTokens = String(bText || "").split(/\s+/).filter(Boolean);
    const maxOverlap = Math.min(aTokens.length, bTokens.length, 8);
    let overlap = 0;

    for (let size = maxOverlap; size > 0; size -= 1) {
      const suffix = aTokens.slice(-size).map((token) => token.toLowerCase()).join(" ");
      const prefix = bTokens.slice(0, size).map((token) => token.toLowerCase()).join(" ");
      if (suffix === prefix) {
        overlap = size;
        break;
      }
    }

    const tail = bTokens.slice(overlap).join(" ");
    return tail ? (left + " " + tail).trim() : left;
  }

  function regroupToSentences(captions, options) {
    const opts = options || {};
    const gapLimitMs = opts.gapMs == null ? REGROUP_GAP_MS : opts.gapMs;
    const maxWords = opts.maxWords == null ? REGROUP_MAX_WORDS : opts.maxWords;
    const out = [];
    let acc = null;

    for (const caption of Array.isArray(captions) ? captions : []) {
      if (!acc) {
        acc = { ...caption };
        continue;
      }

      const gapMs = (caption.start - acc.end) * 1000;
      const endsSentence = /[.!?…。！？]$/.test(acc.text);
      const tooLong = acc.text.split(/\s+/).filter(Boolean).length >= maxWords;

      if (endsSentence || gapMs > gapLimitMs || tooLong) {
        out.push(acc);
        acc = { ...caption };
      } else {
        acc.text = mergeWithDedupe(acc.text, caption.text);
        acc.end = caption.end;
      }
    }

    if (acc) out.push(acc);
    return out;
  }

  return {
    REGROUP_GAP_MS,
    REGROUP_MAX_WORDS,
    parseJson3Events,
    mergeWithDedupe,
    regroupToSentences
  };
});
