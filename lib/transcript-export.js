(function initTranscriptExport(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SubToVoiceTranscriptExport = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function transcriptExportFactory() {
  "use strict";

  function timestamp(seconds) {
    const centiseconds = Math.round(Math.max(0, seconds) * 100);
    const hours = Math.floor(centiseconds / 360000);
    const minutes = Math.floor(centiseconds / 6000) % 60;
    const rest = Math.floor(centiseconds / 100) % 60;
    const fraction = centiseconds % 100;
    const two = (value) => String(value).padStart(2, "0");
    return (hours ? two(hours) + ":" : "") + two(minutes) + ":" + two(rest) + ":" + two(fraction);
  }

  function format(transcript) {
    return (transcript?.rows || []).filter((row) => row.audio?.length).map((row) => [
      row.source,
      row.audio.map((item) =>
        `[${timestamp(item.start)} ~ ${timestamp(item.end)}] ${item.text}`
      ).join(", ")
    ].join("\n")).join("\n\n") + "\n";
  }

  return { timestamp, format };
});
