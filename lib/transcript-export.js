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

  function diagnostics(row) {
    if (!row.id) return [];
    const trace = row.diagnostic || {};
    const elapsed = (value) => Number.isFinite(value) ? `+${value.toFixed(2)}s` : null;
    const stage = (label, start, end, error) => {
      if (error) return `${label}: lỗi — ${error}`;
      if (Number.isFinite(end)) return `${label}: bắt đầu ${elapsed(start)}, xong ${elapsed(end)}`;
      if (Number.isFinite(start)) return `${label}: bắt đầu ${elapsed(start)}, đang chờ`;
      return `${label}: chưa bắt đầu`;
    };
    const speaker = trace.speakerError
      ? `Speaker: lỗi — ${trace.speakerError}; dùng giọng mặc định`
      : trace.speaker
        ? `Speaker: ${trace.speaker}, xong ${elapsed(trace.speakerEnd)}`
        : Number.isFinite(trace.speakerStart)
          ? `Speaker: bắt đầu ${elapsed(trace.speakerStart)}, đang chờ`
          : "Speaker: không áp dụng hoặc chưa bắt đầu";
    const schedule = trace.schedule;
    const scheduling = schedule?.status === "late"
      ? `Xếp lịch: bỏ qua — câu đã trễ ${schedule.lateBy.toFixed(2)}s (giới hạn ${schedule.limit.toFixed(2)}s; video lúc xét ${timestamp(schedule.videoTime)})`
      : schedule?.status === "scheduled"
        ? `Xếp lịch: đã xếp lúc ${elapsed(schedule.at)} (video ${timestamp(schedule.videoTime)})`
        : schedule?.status === "cancelled"
          ? `Xếp lịch: audio chờ phát đã bị hủy lúc video ${timestamp(schedule.videoTime)}`
        : schedule?.status === "start_failed"
          ? "Xếp lịch: lỗi khi khởi động audio"
          : "Xếp lịch: chưa xét";
    return [
      `#${row.id} | video ${timestamp(row.start)} | mốc + tính từ lúc bắt đầu xử lý câu`,
      stage("Dịch", trace.translationStart, trace.translationEnd, trace.translationError),
      speaker,
      stage("TTS", trace.ttsStart, trace.ttsEnd, trace.ttsError),
      scheduling
    ];
  }

  function format(transcript) {
    return (transcript?.rows || []).map((row) => {
      const originals = (row.originals || []).map((item) =>
        `[${timestamp(item.start)} ~ ${timestamp(item.end)}] ${item.text}`
      );
      const audio = (row.audio || []).map((item) =>
        `[${timestamp(item.start)} ~ ${timestamp(item.end)}] ${item.text}`
      );
      return [
        ...diagnostics(row),
        "Phụ đề gốc:",
        ...(originals.length ? originals : ["[Không ghép được phụ đề gốc]"]),
        "Câu đã xử lý: " + (row.processed || "[Không có]"),
        "Bản dịch: " + (row.translation || "[Chưa dịch]"),
        "Audio: " + (audio.length ? audio.join(", ") : "[Chưa phát]")
      ].join("\n");
    }).join("\n\n") + "\n";
  }

  return { timestamp, format };
});
