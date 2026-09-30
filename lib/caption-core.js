(function initCaptionCore(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SubToVoiceCaptionCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function captionCoreFactory() {
  "use strict";

  const REGROUP_GAP_MS = 1500;
  const REGROUP_MAX_WORDS = 15;

  function cleanCaptionText(text) {
    return String(text || "")
      .replace(/<[^>]+>|\u266a/gi, " ")
      .replace(/\[.*?\]/g, " ")
      .replace(/(^|\s)>>(?=\s|$)/g, " ")
      .replace(/\s+/g, " ").trim();
  }

  function splitLongCue(cue) {
    if (cue.text.length <= 120) return [cue];
    const words = cue.text.split(/\s+/);
    const starts = [];
    let offset = 0;
    for (const word of words) { starts.push(offset); offset += word.length + 1; }
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < words.length - 1; i++) {
      const length = starts[i] + words[i].length;
      if (length < 25 || cue.text.length - length < 15) continue;
      const score = (/[,;:\u2014\u2013-]$/.test(words[i]) ? 50 : 0) +
        (/^(which|that|who|whom|whose|and|but|or|nor|because|since|although|though|if|when|where|while|so|yet|however|therefore|moreover|furthermore|unless|until|before|after|as)$/i.test(words[i + 1]) ? 40 : 0) -
        Math.abs(length - 65);
      if (score > bestScore) { bestScore = score; best = i; }
    }
    if (best < 0) return [cue];
    const left = words.slice(0, best + 1).join(" ");
    const right = words.slice(best + 1).join(" ");
    const middle = cue.start + (cue.end - cue.start) * left.length / cue.text.length;
    return [{ ...cue, end: middle, text: left }, { ...cue, start: middle, text: right }];
  }

  function parseJson3Events(events, options) {
    const isAsr = options?.isAsr === true;
    const out = [];
    let pending = null;
    const flush = () => {
      if (!pending) return;
      out.push(...splitLongCue(pending));
      pending = null;
    };
    const items = Array.isArray(events) ? events : [];
    for (let eventIndex = 0; eventIndex < items.length; eventIndex++) {
      const event = items[eventIndex];
      if (!event || !event.segs || typeof event.tStartMs !== "number") continue;
      let eventEnd = (event.tStartMs + (event.dDurationMs || 0)) / 1000;
      if (!isAsr) {
        const text = cleanCaptionText(event.segs.map((segment) => segment.utf8 || "").join(""));
        if (text) out.push({ start: event.tStartMs / 1000, end: eventEnd, text });
        continue;
      }
      for (let nextIndex = eventIndex + 1; nextIndex < items.length; nextIndex++) {
        const nextEvent = items[nextIndex];
        if (nextEvent?.segs?.some((segment) => cleanCaptionText(segment.utf8))) {
          eventEnd = Math.min(eventEnd, nextEvent.tStartMs / 1000);
          break;
        }
      }
      if (pending && event.tStartMs / 1000 - pending.end > 3.5) flush();
      for (let i = 0; i < event.segs.length; i++) {
        const segment = event.segs[i];
        const text = cleanCaptionText(segment.utf8);
        if (!text) continue;
        const start = (event.tStartMs + (segment.tOffsetMs || 0)) / 1000;
        const next = event.segs[i + 1];
        const end = Math.max(start + 0.3, next ? (event.tStartMs + (next.tOffsetMs || 0)) / 1000 : eventEnd);
        if (!pending) pending = { start, end, text };
        else {
          pending.text = mergeWithDedupe(pending.text, text);
          pending.end = Math.max(pending.end, end);
        }
        if (/[.?!]$/.test(text) || pending.end - pending.start > 15 || pending.text.length > 120) flush();
      }
    }
    flush();
    if (isAsr) {
      for (let i = 0; i < out.length - 1; i++) {
        out[i].end = Math.min(out[i].end, out[i + 1].start);
      }
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
      const cleaned = cleanCaptionText(caption?.text);
      if (!cleaned) continue;
      const current = { ...caption, text: cleaned };
      if (!acc) {
        acc = current;
        continue;
      }

      const gapMs = (current.start - acc.end) * 1000;
      const endsSentence = /[.!?…。！？]$/.test(acc.text);
      const tooLong = acc.text.split(/\s+/).filter(Boolean).length >= maxWords;

      if (endsSentence || gapMs > gapLimitMs || tooLong || acc.end - acc.start > 15 || acc.text.length > 120) {
        out.push(acc);
        acc = current;
      } else {
        acc.text = mergeWithDedupe(acc.text, current.text);
        acc.end = Math.max(acc.end, current.end);
      }
    }

    if (acc) out.push(acc);
    return out;
  }

  function assignRawCaptions(rawCaptions, sentences) {
    const groups = (sentences || []).map(() => []);
    const orphans = [];
    for (const caption of rawCaptions || []) {
      let bestIndex = -1;
      let bestOverlap = 0;
      let low = 0;
      let high = groups.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (sentences[middle].end <= caption.start) low = middle + 1;
        else high = middle;
      }
      for (let index = low; index < groups.length && sentences[index].start < caption.end; index += 1) {
        const sentence = sentences[index];
        const overlap = Math.min(caption.end, sentence.end) - Math.max(caption.start, sentence.start);
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestIndex = index;
        }
      }
      if (bestIndex === -1) orphans.push(caption);
      else groups[bestIndex].push(caption);
    }
    return { groups, orphans };
  }

  return {
    REGROUP_GAP_MS,
    REGROUP_MAX_WORDS,
    parseJson3Events,
    cleanCaptionText,
    mergeWithDedupe,
    regroupToSentences,
    assignRawCaptions
  };
});
