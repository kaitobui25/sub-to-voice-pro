# Sub-to-Voice Pro

Chrome Manifest V3 subtitle-first dubbing for normal, non-live YouTube VODs that already have captions.

## Bắt đầu nhanh (Windows + Chrome)

Cần Git, Node.js/npm, `uv` và một Gemini API key. Chạy trong PowerShell:

    git clone https://github.com/kaitobui25/sub-to-voice-pro.git
    cd sub-to-voice-pro
    Copy-Item .env.example .env

Mở `.env`, điền `GEMINI_API_KEY1`, rồi cài VieNeu và tạo cấu hình extension:

    New-Item -ItemType Directory -Force ..\tools
    git clone https://github.com/pnnbao97/VieNeu-TTS.git ..\tools\VieNeu-TTS
    Push-Location ..\tools\VieNeu-TTS
    uv sync
    Pop-Location
    npm run config

Vào `chrome://extensions` → bật **Developer mode** → **Load unpacked** → chọn thư mục `sub-to-voice-pro`. Lấy ID extension ở trang đó, rồi chạy:

    npm run vieneu:install-host -- <extension-id>

Reload extension, mở video YouTube có phụ đề và bật công tắc trong popup. VieNeu sẽ tự khởi động. Nếu đã có `..\tools\VieNeu-TTS`, bỏ qua lệnh clone và chạy `uv sync` trong thư mục đó. Chi tiết và lệnh kiểm tra nằm bên dưới.

The MVP follows the locked Echoly baseline in docs/ECHOLY_BASELINE.md:

- YouTube captions -> JSON3 -> sentence regroup/dedupe
- translation batches of at most 10 lines
- first wave of 2 forward sentences
- complete-file TTS with provider-configured render concurrency
- decodeAudioData() -> AudioBuffer
- Web Audio scheduling at original subtitle timestamps
- 30-second rolling lookahead
- seek/pause/resume/Stop cleanup with one active session

Translation and TTS are provider-neutral at the core boundary. The popup defaults to Google Translate with Microsoft fallback, and VieNeu TTS. Gemini and Auto modes are also available; Auto tries Google, Microsoft, then Gemini for translation, and VieNeu then Gemini for TTS. Provider orders, models, endpoints, voices, and concurrency come from config.yaml.
Gemini translation rotates through configured models after successful batches. On HTTP 429 or transient server failures (500/502/503/504), the adapter records a per-model cooldown and continues with the next configured model; later requests skip models still cooling down. Retry-After/provider detail is honored when present.
TTS models are tried in config order; the adapter falls back to the next configured TTS model only when the current model returns HTTP 429.
After a 429, the adapter remembers that model's cooldown from Retry-After (or the provider error message) and skips it until the cooldown expires, preventing repeated rate-limit calls.

## Local development

1. Copy .env.example to .env.
2. Add one Gemini key locally as GEMINI_API_KEY1. The legacy GEMINI_API_KEY name is also accepted.
3. Choose TTS locally with TTS_PROVIDER=gemini or TTS_PROVIDER=vieneu. If omitted, config.yaml is used.
4. Generate the gitignored runtime bridge:

       npm run config

5. Open chrome://extensions.
6. Enable Developer mode, choose Load unpacked, and select this folder.
7. Open a normal captioned YouTube VOD at 1x speed.
8. In the popup, use **Tải TXT gốc + bản dịch** to save captions from the video position where dubbing was switched on through the position where TXT is downloaded. Each group lists original YouTube captions, the processed English sentence, its translation, then dubbed audio intervals. Unprocessed, untranslated, and unplayed parts remain in the TXT with an explicit status.
9. Click the extension action to open the popup. Use the switch to start or stop dubbing, the slider to set the original video volume, and the dropdowns to select translation and TTS. Changing a provider while dubbing restarts the session at the current video position.
10. The voice-mode dropdown defaults to **Một giọng**. Choose **Nhiều giọng** with VieNeu to label numbered processed subtitle lines through Gemini and use the configured speaker voices. The first two voices are Hải Đăng (male, North) and Thái Sơn (male, South); Quang Sơn (male, Central) is configured if a third speaker is detected. Changing this mode restarts the current session.
11. In **Nhiều giọng**, each completed TTS sentence is scheduled immediately. The extension prepares speaker labels and translations ahead of playback; if the next sentence has no audio yet, video playback waits and resumes when VieNeu finishes. The lookahead range is configured under `speaker_detection` in `config.yaml`.

runtime-config.local.json contains local development credentials. It is generated from .env, is gitignored, and must not be committed or shared.

The small panel injected on YouTube is a development status surface only. Production settings UI is deferred.

## Local VieNeu-TTS v3 Turbo

The Windows CPU/ONNX install lives outside this extension repo at:

    ..\tools\VieNeu-TTS

With Git and `uv` installed, run these commands from this extension folder:

    git clone https://github.com/pnnbao97/VieNeu-TTS.git ..\tools\VieNeu-TTS
    Push-Location ..\tools\VieNeu-TTS
    uv sync
    Pop-Location
    npm run vieneu:start
    npm run vieneu:health

If `..\tools\VieNeu-TTS` already exists, skip the clone and run `uv sync` there. The start script expects its `.venv` in that directory.

On Windows, install the native startup helper once using the ID shown at `chrome://extensions`:

    npm run vieneu:install-host -- <extension-id>

Reload the extension after installation. With `TTS_PROVIDER=vieneu`, clicking the extension starts VieNeu automatically if it is stopped and waits for `/health` before dubbing. The helper is registered for that extension ID; repeat installation if Chrome assigns a new ID. Manual server controls remain available:

    npm run vieneu:start
    npm run vieneu:health
    npm run vieneu:stop

The server is configured to bind only to http://127.0.0.1:8000. Current local defaults are VieNeu-TTS v3 Turbo, voice Hải Đăng, 48 kHz, and one concurrent synthesis request on CPU. Change the local model/voice/endpoint in config.yaml, then rerun npm run config and reload the extension.

## Preparing audio before playback

ON pauses the video while captions, translation, speaker labels and the initial
Vietnamese audio buffer are prepared. Playback begins only after the requested
startup span is ready. Startup and grouped resume never release incomplete audio
just because a timer has expired.
Late Vietnamese cues are retained. If rolling TTS falls behind, playback waits
for audio instead of skipping sentences.

`audio_preparation.startup_seconds` sets initial buffered coverage, with the
adaptive target capped by `max_buffer_seconds`. `planning_seconds` is the horizon
used to cover the measured synthesis deficit; the startup target may grow while
audio is being prepared and stays stable once increased. `max_queued_sentences` bounds
rolling TTS work. Decoded audio older than `retain_past_seconds` is released
when no longer scheduled; future audio required for playback is retained.
The JSON diagnostic export includes current cache bytes and queued TTS count.
After changing `config.yaml`, run `npm run config` and reload the extension.

The local `vieneu_tts.complete_audio` option asks the patched server to produce
the complete audio response before sending headers. This matches the extension's
complete-file decoding and releases the synthesis slot even when the client
disconnects. `scripts/vieneu-start.ps1` applies the opt-in API patch before starting
the server. Streaming requests from other clients keep their existing behavior.

## Checks

Run deterministic checks without provider calls:

    npm test
    npm run check

Generate local config:

    npm run config

Tiny real-provider smoke tests consume provider quota or credits:

    npm run smoke:gemini
    npm run smoke:tts
    npm run smoke:gemini-tts

The translation smoke translates exactly two short lines. The generic TTS smoke synthesizes one short Vietnamese sentence using the selected TTS provider and verifies a complete RIFF/WAV file. The explicit Gemini TTS smoke remains available when Gemini TTS is selected/configured.

## Current scope

Included: normal captioned YouTube VOD, Gemini translation adapter, configurable Gemini TTS adapter, local VieNeu-TTS v3 Turbo adapter, complete audio-file decoding, timestamp scheduler, rolling lookahead, pause/resume/seek/Stop lifecycle.

Deferred: production UI, Realtime/WebRTC, no-caption audio capture fallback, live streams, non-YouTube sources, streaming TTS, AudioWorklet, playback-rate scheduling, backend/proxy.

Third-party attribution is in THIRD_PARTY_NOTICES.md. Current gate results and remaining browser checks are in docs/VALIDATION.md.
