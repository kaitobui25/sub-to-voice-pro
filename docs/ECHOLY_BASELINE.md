# Echoly subtitle-first baseline

Reference: `../references/echoly` (MIT, © 2026 Son Nguyen Tung).

This document freezes the behavior that Sub-to-Voice-Pro ports for the current MVP. The reference tree is read-only.

## Flow

1. Detect the YouTube video id from the current watch/embed URL.
2. Acquire a signed YouTube `timedtext` URL. Prefer the background `webRequest` cache; if cold, toggle YouTube CC briefly to trigger the request. Fall back to `ytInitialPlayerResponse` caption tracks, then the legacy plain timedtext URL.
3. Parse JSON3 events into ordered `{ start, end, text }` cues.
4. Regroup ASR-sized cues into sentence-sized units. Deduplicate overlapping ASR tokens while joining cues.
5. Start from the current playhead, translate the first two forward sentences, render their TTS, decode complete audio files with `decodeAudioData()`, then resume playback quickly.
6. Keep translation and TTS rendered 30 seconds ahead. Translation batches contain at most 10 sentences; TTS uses five concurrent workers.
7. Schedule every ready `AudioBuffer` with `AudioBufferSourceNode.start()` using `audioOffset = audioContext.currentTime - video.currentTime` and `playAt = audioOffset + sentence.start`.
8. Skip materially late cues instead of replaying stale speech over newer subtitles.
9. On seek, cancel scheduled sources, recompute `audioOffset`, and schedule around the new playhead.
10. On Stop, abort requests, cancel sources, disconnect audio nodes, close the `AudioContext`, and clear session state.

## Locked constants

- Translation batch size: `10`
- Lookahead: `30_000 ms`
- TTS render concurrency: `5`
- Regroup gap: `1_500 ms`
- Regroup maximum words: `15`
- First wave: `2` forward sentences from the current playhead
- Late cue threshold: `0.5 s`

## Source-to-destination map

| Echoly function/area | Destination responsibility |
| --- | --- |
| `ytCaptionCache`, timedtext `webRequest`, `GET_YT_CC_URL` | `background.js`: signed caption URL cache and content lookup |
| `getYouTubeVideoId`, CC button helpers, `fetchCCViaIntercept`, player-response fallback | `content.js`: caption acquisition |
| `parseJson3Events`, `mergeWithDedupe`, `regroupToSentences` | `content.js`: ordered sentence pipeline |
| `batchTranslateSubtitles`, `translateBatch` | provider-neutral translation manager plus Gemini adapter |
| `renderTTSForSentence`, `renderWaveTTS` | provider-neutral TTS manager plus NovAI adapter; shared audio decode stays outside adapter |
| `scheduleWindow`, `scheduleAroundPlayhead`, `cancelPendingSources` | Web Audio timestamp scheduler |
| `runRollingRenderer` | 30-second rolling translation/TTS renderer |
| `applyVolumes`, `bindVolumeDriftGuard` | separate YouTube original volume and shared dub `GainNode` |
| `startSubtitleFirstSession`, `stopSession` | single-session lifecycle and cleanup |

## Approved differences from Echoly

- Translation and TTS are provider interfaces. Core caption/scheduler code must not contain Gemini, NovAI, or MiniMax request schemas.
- No Realtime, MediaRecorder, no-caption audio fallback, live-stream, playback-rate scheduling, streaming TTS, AudioWorklet, or backend server in this MVP.
- Missing captions are a terminal, visible error for this phase.
- Subtitle-first pause cancels scheduled dub sources. Resume recomputes `audioOffset` and reschedules around the playhead.
- Development credentials come from a root `.env` through a generated, gitignored runtime config file.

## Attribution

Code adapted from Echoly must retain the MIT license notice. The project includes a copy of the upstream MIT license in `THIRD_PARTY_NOTICES.md`.
