# Sub-to-Voice Pro

Chrome Manifest V3 subtitle-first dubbing for normal, non-live YouTube VODs that already have captions.

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
