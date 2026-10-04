"""Add an opt-in complete WAV response to the installed VieNeu API.

The extension decodes complete audio files. Producing their bytes before sending
headers also releases the CPU synthesis slot independently of disconnected clients.
"""
from pathlib import Path

SERVER = Path(__file__).resolve().parents[2] / "tools/VieNeu-TTS/apps/openai_speech.py"
MARKER = "# Sub-to-Voice complete audio v1"


def patch(source):
    if MARKER in source:
        return source
    replacements = [
        ("from fastapi.responses import JSONResponse, StreamingResponse",
         "from fastapi.responses import JSONResponse, Response, StreamingResponse"),
        ('    stream_format: str = "audio"',
         '    stream_format: str = "audio"\n    complete_audio: bool = False'),
        ('    if req.stream_format == "sse":',
         '''    # Sub-to-Voice complete audio v1
    if req.complete_audio and req.stream_format == "audio":
        try:
            body = b"".join(_audio_body(chunks, fmt, req.sample_rate))
        finally:
            chunks.close()
            slot.release()
        media = "audio/wav" if fmt == "wav" else "audio/pcm"
        return Response(body, media_type=media, headers=headers)
    if req.stream_format == "sse":'''),
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
    print("VieNeu complete-audio patch ready; restart server to activate.")
