# Sub-to-Voice Pro

Chrome Manifest V3 subtitle-first dubbing for normal, non-live YouTube VODs that already have captions.

The MVP follows the locked Echoly baseline in docs/ECHOLY_BASELINE.md:

- YouTube captions -> JSON3 -> sentence regroup/dedupe
- translation batches of at most 10 lines
- first wave of 2 forward sentences
- complete-file TTS with 5 concurrent render workers
- decodeAudioData() -> AudioBuffer
- Web Audio scheduling at original subtitle timestamps
- 30-second rolling lookahead
- seek/pause/resume/Stop cleanup with one active session

Translation and TTS are provider-neutral at the core boundary. The current adapters both use Gemini APIs; the TTS model is selected in config.yaml rather than hard-coded in runtime code.

## Local development

1. Copy .env.example to .env.
2. Add GEMINI_API_KEY locally.
3. Generate the gitignored runtime bridge:

       npm run config

4. Open chrome://extensions.
5. Enable Developer mode, choose Load unpacked, and select this folder.
6. Open a normal captioned YouTube VOD at 1x speed.
7. Click the extension action to Start or Stop.

runtime-config.local.json contains local development credentials. It is generated from .env, is gitignored, and must not be committed or shared.

The small panel injected on YouTube is a development status surface only. Production settings UI is deferred.

## Checks

Run deterministic checks without provider calls:

    npm test
    npm run check

Generate local config:

    npm run config

Tiny real-provider smoke tests consume provider quota or credits:

    npm run smoke:gemini
    npm run smoke:tts

The translation smoke translates exactly two short lines. The TTS smoke synthesizes one short Vietnamese sentence using the configured TTS model and verifies a complete RIFF/WAV file.

## Current scope

Included: normal captioned YouTube VOD, Gemini translation adapter, configurable Gemini TTS adapter, complete audio-file decoding, timestamp scheduler, rolling lookahead, pause/resume/seek/Stop lifecycle.

Deferred: production UI, Realtime/WebRTC, no-caption audio capture fallback, live streams, non-YouTube sources, streaming TTS, AudioWorklet, playback-rate scheduling, backend/proxy.

Third-party attribution is in THIRD_PARTY_NOTICES.md. Current gate results and remaining browser checks are in docs/VALIDATION.md.
