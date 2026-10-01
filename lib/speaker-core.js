(function initSpeakerCore(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SubToVoiceSpeakerCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function speakerCoreFactory() {
  "use strict";

  function buildPrompt(lines, context) {
    return `Identify who speaks each processed English subtitle line. You do not know the video, names, roles, topic, or number of speakers. Use only these lines.
Assign S1 to the first distinguishable speaker, S2 to the next, S3 to the next, and so on. Preserve labels shown in previous context. Use U when a fragment is ambiguous or contains multiple speakers. A question, quoted words, or a short acknowledgment alone do not prove a speaker change. Never invent names or context.
Previous labeled context: ${JSON.stringify(context)}
Lines to label: ${JSON.stringify(lines)}
Return ONLY JSON {"lines":["ID S1","ID S2"]}, one string for every input ID in the same order. Each string must contain only its numeric ID, one space, and S1/S2/S3... or U. No explanations.`;
  }

  function parseLabels(output, lines) {
    if (!Array.isArray(output) || output.length !== lines.length) {
      throw new Error("Speaker response count does not match input.");
    }
    return output.map((value, index) => {
      const match = String(value).trim().match(/^(\d+)\s+(S[1-9]\d*|U)$/);
      if (!match || Number(match[1]) !== lines[index].id) {
        throw new Error("Invalid speaker label for line " + lines[index].id);
      }
      return match[2];
    });
  }

  function voiceForSpeaker(speaker, voices, fallback) {
    const index = /^S[1-9]\d*$/.test(speaker || "") ? Number(speaker.slice(1)) - 1 : -1;
    return Array.isArray(voices) && voices.length > 0 && index >= 0
      ? voices[index % voices.length] : fallback;
  }

  return { buildPrompt, parseLabels, voiceForSpeaker };
});
