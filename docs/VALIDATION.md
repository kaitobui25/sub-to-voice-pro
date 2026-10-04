# MVP validation status

Validation date: 2026-09-29.

## Passed

- Echoly subtitle-first baseline audited and mapped.
- Caption parse/regroup/dedupe deterministic tests pass.
- Translation batch size is 10; order and output count are validated.
- Real Gemini smoke passed with two ordered Vietnamese translations using gemini-2.5-flash.
- Gemini translation fallback tests cover HTTP 429 model switching, Retry-After cooldown persistence across provider instances, all-models-cooling behavior, and non-429 no-fallback behavior.
- Gemini translation also treats transient server failures (500/502/503/504) as model-local temporary failures: the failing model receives a short cooldown and the request continues with the next configured model.
- Real Gemini translation smoke passed after enabling the configured multi-model fallback chain; two short lines returned ordered Vietnamese output.
- TTS provider contract and Gemini TTS request/response adapter tests pass.
- Real Gemini TTS smoke passed with one short Vietnamese sentence using the TTS model selected from config; response was 59,826 bytes of audio/wav.
- Real TTS fallback smoke passed: the configured Flash-Lite model hit HTTP 429, then the adapter switched to the next configured model and returned 73,266 bytes of audio/wav from gemini-3.8-flash-tts.
- Rate-limit cooldown tests pass: Retry-After/error cooldown persists across provider instances, the limited model is skipped on later requests, and no API request is made while all configured TTS models are cooling down.
- VieNeu-TTS v3 Turbo was installed locally with uv in ../tools/VieNeu-TTS using the CPU/ONNX path.
- Local VieNeu health check passed on 127.0.0.1:8000: backend onnx, 48 kHz, 25 voices, max_streams=1.
- Direct local API smoke returned a valid RIFF/WAVE file for one short Vietnamese sentence.
- The extension VieNeu adapter real smoke passed through runtime-config.local.json and returned a complete WAV using the configured local model/voice.
- VieNeu adapter tests cover OpenAI-compatible request shape, streaming WAV header repair, unsupported speed behavior, and local API errors.
- Scheduler tests cover timestamp math, 30-second lookahead, late-cue skip, duplicate prevention, and source cancellation.
- Provider-message cancellation test proves Abort sends a background cancellation request and ignores a late reply.
- Session code implements one active session, pause/resume resync, seek cancel/reschedule, Stop cleanup, ended cleanup, and YouTube SPA cleanup.
- Edge 154.0.4258.37 headless loaded the unpacked extension in a disposable profile: the MV3 service worker registered, the YouTube content script injected, CONTENT_PING round-tripped, and the test VOD exposed 53 caption tracks.
- .env and generated runtime config are gitignored.
- Echoly reference repository remains clean.

Official Chrome 154.0.8037.58 ignored the command-line unpacked-extension flags in the disposable automation profile. Manual Load unpacked remains the Chrome validation path. Edge headless provides a working automated MV3 load/injection gate on this host.

## Browser checks still required after the TTS provider switch

### Audio preparation correction (2026-10-04)

- Removed the continuous mode and its expired-cue dropping behavior after the
  user reported missing Vietnamese audio. ON now pauses playback for preparation.
- Startup requires the complete requested audio span, including when synthesis
  exceeds the old startup time budget. Future buffers remain available for resume.
- TTS initialization runs in the synthesis path after the video has been paused.
- Queued TTS remains bounded and old completed audio is released.
- Regression tests verify startup beyond the old deadline, late queued audio
  retention, starting an initially paused video after preparation, and preserving
  a user pause during rolling rendering.
- Live BrowserOS neo check used the existing `Yu0z7-KMHpo` tab after the user
  navigated to that video; no additional YouTube tab was opened. ON paused at
  222.10 seconds. Startup finished after 29.18 seconds, with 10.30 seconds of
  ready coverage before the first play. The subsequent observed interval had
  zero skipped/late-drop events. At 254.75 seconds, rolling TTS required about
  5 seconds of buffering, then resumed. Initial buffering does not guarantee
  uninterrupted playback for the entire video when CPU synthesis falls behind.
- `npm test`: 106 passed. `npm run check` and `git diff --check`: passed.

### Five-minute live playback test (2026-10-04)

- Existing Neo tab: `Yu0z7-KMHpo`, 1x speed, one YouTube tab.
- Observation: 06:36:27–06:44:02 UTC. Video advanced from 342.50 to
  642.73 seconds: **300.22 seconds of video**, without seeking or changing code.
- Wall time: 455.01 seconds, including 95.89 seconds of startup preparation.
- During playback: **12 buffering pauses**, totaling **57.58 seconds**.
  Longest individual pause: 6.28 seconds. Therefore the no-pause goal is not met.
- All 105 caption cues intersecting the interval had a scheduling event.
  No expired-cue drop events, TTS errors, or discarded diagnostic ring events.
  Scheduling coverage is not a measurement of audible waveform completeness.
- Outstanding TTS peaked at 8 cues. Recorded decoded audio cache peaked at
  1,305,600 bytes (1.25 MiB). Python TTS worker working set observations stayed
  at 1,183.2–1,184.6 MiB; private bytes stayed at 1,732.5–1,733.5 MiB.
  These observations do not establish a CPU reduction or total browser RAM.
- At 561.04 seconds, playback resumed after 5.82 seconds but paused again at
  561.13 seconds, about 83 ms after the play event. This repeated buffering
  remains a concrete issue: resume was allowed while the following cue was pending.
- One request around session restart logged 91.81 seconds of server stream wall
  time for 3.20 seconds of audio. Its cause requires separate investigation;
  this telemetry includes generator/stream wall time and does not isolate CPU inference.
- Full raw diagnostics and the bounded playback observer are saved in
  `artifacts/five-minute-playback-2026-10-04.json`.

| Video pause position | Wait (seconds) |
| --- | ---: |
| 6:09 | 5.06 |
| 6:43 | 4.30 |
| 7:18 | 4.21 |
| 7:40 | 1.90 |
| 8:06 | 4.54 |
| 8:51 | 5.13 |
| 9:21 | 5.82 |
| 9:21 | 6.28 |
| 9:44 | 5.09 |
| 10:02 | 5.06 |
| 10:09 | 5.11 |
| 10:32 | 5.09 |

### Adaptive preparation and second five-minute test (2026-10-04)

- Resume now requires the entire configured ready span; waiting longer than a
  deadline cannot bypass readiness. Startup coverage increases with observed
  synthesis cost, bounded by the configured 120-second ceiling.
- Ready callbacks schedule cached cues near the playhead in caption order.
  An exploratory run exposed premature scheduling of far-future cues; that run
  was stopped, corrected, and excluded from the result below.
- VieNeu supports an opt-in complete-file response that releases its synthesis
  slot before sending the response. The startup script applies an idempotent,
  source-validated patch. A cancellation smoke returned a valid subsequent WAV
  in 7.74 seconds, without the previous roughly 91-second occupied stream.
- Local CPU benchmarks retained six ONNX threads. The three-thread result was
  slower and may include overlap with the old server; it is not a controlled
  CPU comparison. No model, voice, or precision change was applied.
- Existing Neo YouTube tab `Yu0z7-KMHpo`, 1x speed, one YouTube tab:
  video advanced from 342.50 to 642.855 seconds, **300.355 seconds of video**.
  Observation started at 07:15:21 UTC and finished at 07:24:26 UTC.
- **Zero pauses after startup**, zero skipped-cue events, zero TTS errors, and
  zero discarded diagnostic events. Startup took **243.82 seconds**; wall time
  was 545.03 seconds. This trades longer initial preparation for continuous
  playback in this measured interval; it does not guarantee every video.
- All **105/105** eligible cues were scheduled. **97/105** completed within the
  five-minute window; **105/105** had completed by the final diagnostic capture
  at video time 749.48 seconds. Maximum cue start drift was **24.81 seconds**.
  Audible waveform completeness was not measured; synchronization remains an
  unresolved limitation even though no whole cue was dropped.
- The complete-audio runtime option forwarding was corrected and activated
  during early playback at approximately 389.73 seconds. Content preparation
  and scheduling code remained unchanged throughout the measured interval.
  Playback continued beyond 749 seconds without a buffering event, giving more
  than five minutes of video after the final runtime option was activated.
- Decoded audio cache peaked at **8,488,960 bytes (8.10 MiB)**, versus 1.25 MiB
  in the earlier test. Outstanding synthesis remained bounded at eight cues.
  Warm worker working set observations were 1,333.5-1,338.7 MiB; private bytes
  were 1,723.9-1,727 MiB. These are not a controlled before/after RAM benchmark
  and do not establish a CPU reduction or total browser memory usage.
- Raw diagnostics, observer samples, and summary are saved in
  `artifacts/five-minute-playback-improved-2026-10-04.json`.
- Regression suite: **110 passed**. Coverage includes strict resume readiness,
  adaptive startup, future-cue ordering, optional complete-file requests, and
  runtime configuration forwarding.

Use a short captioned VOD window at 1x speed and verify:

1. Start at the beginning: first two dubbed lines become audible near subtitle timestamps, then a short rolling lookahead.
2. Start mid-video: first wave begins from the current playhead.
3. Pause for at least 5 seconds: no dub continues; resume resyncs.
4. Seek forward and backward: stale sources are cancelled and dub reschedules.
5. Stop during playback or a request: immediate dub silence and cleanup.
6. Failure paths: invalid provider key, no captions, provider error, Stop during request.

Do not record or paste API keys into validation notes.
