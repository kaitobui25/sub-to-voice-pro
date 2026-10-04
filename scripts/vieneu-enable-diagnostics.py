"""Add bounded request timing telemetry to the installed local VieNeu server.

Run again after updating VieNeu. Refuse unfamiliar source instead of guessing.
Restart the server after applying this patch.
"""
from pathlib import Path

SERVER = Path(__file__).resolve().parents[2] / "tools/VieNeu-TTS/apps/openai_speech.py"
MARKER = "# Sub-to-Voice request diagnostics v1"


def patch(source):
    if MARKER in source:
        return source
    replacements = [
        ("import base64", """import base64
from collections import OrderedDict
# Sub-to-Voice request diagnostics v1
_diagnostics = OrderedDict()
"""),
        ("import threading", "import threading\n_diagnostics_lock = threading.Lock()"),
        ("    first = None\n    emitted = 0", "    cpu_started = time.process_time()\n    first = None\n    emitted = 0"),
        ("        audio_s = emitted / SAMPLE_RATE", """        audio_s = emitted / SAMPLE_RATE
        with _diagnostics_lock:
            _diagnostics[rid] = {
                "requestId": rid, "backend": eng.backend,
                "device": "cpu" if eng.backend == "onnx" else str(getattr(eng.tts.engine, "device", "unknown")),
                "inferenceMs": total * 1000,
                "processCpuMs": (time.process_time() - cpu_started) * 1000,
                "firstAudioMs": first * 1000 if first is not None else None,
                "audioDurationSeconds": audio_s,
                "realTimeFactor": total / audio_s if audio_s else None,
                "gpuUtilization": None,
                "cpuMeasurementScope": "whole_server_process_during_request",
            }
            while len(_diagnostics) > 256:
                _diagnostics.popitem(last=False)"""),
        ("    eng.acquire()   #", "    queued_at = time.perf_counter()\n    eng.acquire()   #"),
        ("    slot = _Slot(eng)", "    queue_ms = (time.perf_counter() - queued_at) * 1000\n    slot = _Slot(eng)"),
        ('    ignored = [k for k', '''    headers["X-VieNeu-Queue-Ms"] = str(queue_ms)
    ignored = [k for k'''),
        ('@app.get("/health")', '''@app.get("/v1/diagnostics/{request_id}", dependencies=[Depends(_auth)])
def request_diagnostics(request_id: str):
    with _diagnostics_lock:
        result = _diagnostics.get(request_id)
        if result is None:
            raise HTTPException(404, "request diagnostics not available")
        return dict(result)


@app.get("/health")'''),
    ]
    for before, after in replacements:
        if source.count(before) != 1:
            raise RuntimeError(f"Unsupported VieNeu source at: {before!r}")
        source = source.replace(before, after, 1)
    compile(source, str(SERVER), "exec")
    return source


if __name__ == "__main__":
    original = SERVER.read_text(encoding="utf-8")
    updated = patch(original)
    if updated != original:
        SERVER.write_text(updated, encoding="utf-8")
    print("VieNeu diagnostics patch ready; restart server to activate.")
