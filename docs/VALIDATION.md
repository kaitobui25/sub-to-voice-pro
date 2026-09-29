# MVP validation status

Validation date: 2026-09-29.

## Passed

- Echoly subtitle-first baseline audited and mapped.
- Caption parse/regroup/dedupe deterministic tests pass.
- Translation batch size is 10; order and output count are validated.
- Real Gemini smoke passed with two ordered Vietnamese translations using gemini-2.5-flash.
- TTS provider contract and Gemini TTS request/response adapter tests pass.
- Real Gemini TTS smoke passed with one short Vietnamese sentence using the TTS model selected from config; response was 59,826 bytes of audio/wav.
- Real TTS fallback smoke passed: the configured Flash-Lite model hit HTTP 429, then the adapter switched to the next configured model and returned 73,266 bytes of audio/wav from gemini-3.8-flash-tts.
- Scheduler tests cover timestamp math, 30-second lookahead, late-cue skip, duplicate prevention, and source cancellation.
- Provider-message cancellation test proves Abort sends a background cancellation request and ignores a late reply.
- Session code implements one active session, pause/resume resync, seek cancel/reschedule, Stop cleanup, ended cleanup, and YouTube SPA cleanup.
- Edge 154.0.4258.37 headless loaded the unpacked extension in a disposable profile: the MV3 service worker registered, the YouTube content script injected, CONTENT_PING round-tripped, and the test VOD exposed 53 caption tracks.
- .env and generated runtime config are gitignored.
- Echoly reference repository remains clean.

Official Chrome 154.0.8037.58 ignored the command-line unpacked-extension flags in the disposable automation profile. Manual Load unpacked remains the Chrome validation path. Edge headless provides a working automated MV3 load/injection gate on this host.

## Browser checks still required after the TTS provider switch

Use a short captioned VOD window at 1x speed and verify:

1. Start at the beginning: first two dubbed lines become audible near subtitle timestamps, then a short rolling lookahead.
2. Start mid-video: first wave begins from the current playhead.
3. Pause for at least 5 seconds: no dub continues; resume resyncs.
4. Seek forward and backward: stale sources are cancelled and dub reschedules.
5. Stop during playback or a request: immediate dub silence and cleanup.
6. Failure paths: invalid provider key, no captions, provider error, Stop during request.

Do not record or paste API keys into validation notes.
