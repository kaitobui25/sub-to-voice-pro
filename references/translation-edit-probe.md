# Translation editing experiment

Standalone simulation of `Google Vietnamese draft + English source/context ->
Gemini Vietnamese edits -> future TTS input`. It makes real API calls but does
not create speech, schedule playback, or change extension configuration.

## Run

```powershell
node references/translation-edit-probe.mjs 'D:\Phong\03_Finance\Voice\sub-to-voice\LOG\sub-to-voice-U7apPfqHgvg.txt' artifacts/translation-edit-probe-2026-10-05.json
```

Append `--dry-run` to inspect inputs without sending API requests. The API key
is read from the gitignored `runtime-config.local.json` and never saved in the
report. Running again overwrites the specified report; use a new output filename
to preserve a previous measurement.

## Method

- Reads model names and endpoint from local runtime configuration, including
  the two configured TTS model names as compatibility checks.
- Uses the same ten target cues, source text, Google drafts, and adjacent English
  context in each request. Fixture IDs: 202, 205, 208, 215, 224, 236, 237, 248,
  253, 260. These cases test wrong referents, idioms, fillers, business meanings,
  fragmented noun phrases, dates, and clause attachment.
- Three rounds, sequential requests, rotated model order. No fallback or retry.
  HTTP 400/404 requests are not repeated. HTTP 503 failures remain failures.
- Temperature 0, JSON response MIME type, 4,096 output tokens, default thinking
  settings, 35-second request timeout. A timeout means unsuitable under this
  experiment's deadline; it does not prove that the model cannot finish later.
- Records complete response latency, model version when returned, usage,
  HTTP errors, and every output. Validity checks exact count/order/IDs and
  nonempty strings. Semantic quality requires separate review.
- Median/max report successful requests only; failed request times remain in
  raw attempts. Three attempts do not establish long-term reliability, a p95,
  or performance under concurrent extension activity. Repeated prompts may also
  benefit from provider-side caching; this does not isolate model compute time.

## Review criteria

1. `they` refers to tools, not people (202).
2. `whatnot` is a conversational continuation, not "nothing" (205).
3. `saturated space` refers to a market, not physical space (208).
4. `like insights` is not "similar understanding" (215).
5. `move` is how employees act/work, not physical travel (224).
6. The pair 236/237 conveys one ready, clear list without duplication or invention.
7. `moving pieces` conveys multiple tasks/details to coordinate (248).
8. `date ... captured` means recorded dates, not captured romantic dates (253).
9. `which really matters` describes fewer omissions, not fewer important items (260).

Naturalness and semantic accuracy are judged separately. An awkward but correct
translation is not a schema failure; valid JSON is not a quality guarantee.

The two `*-tts` models are speech generators, not text editors. Their JSON
compatibility errors are kept in the report rather than ranked as text-editing
latency. Official documentation: [Gemini TTS](https://ai.google.dev/gemini-api/docs/speech-generation),
[Flash-Lite TTS modalities](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash-lite-tts).

## Measured result: 2026-10-05

23 API requests were made: three for each of seven text models, and one JSON
compatibility request for each of two TTS models. The unchanged prompt edits
ten cues per request. Values below are seconds per batch, not per cue.

| Model | Valid/requested | Median successful response | Maximum successful response | Observation |
| --- | ---: | ---: | ---: | --- |
| gemini-3.5-flash-lite | 3/3 | 2.29 | 2.44 | Fastest, smallest observed latency spread |
| gemini-3.1-flash-lite | 3/3 | 4.92 | 12.25 | More natural market wording, one slow response |
| gemini-2.5-flash | 3/3 | 16.14 | 16.82 | Corrected key errors but slower; wording still sometimes literal |
| gemini-3-flash-preview | 1/3 | 34.97 | 34.97 | One 503 and one 35-second timeout |
| gemini-3.8-flash | 0/3 | — | — | All returned 503, high demand |
| gemini-3.7-flash | 0/3 | — | — | All returned 503, high demand |
| gemini-flash-latest | 0/3 | — | — | All returned 503, high demand |
| gemini-3.8-flash-lite-tts | 0/1 | — | — | 400: JSON mode is not enabled |
| gemini-3.8-flash-tts | 0/1 | — | — | 400: JSON mode is not enabled |

### Manual semantic review

All successful models corrected the major date/capture, whatnot, tool pronoun,
market-space, physical-motion, and fragmented-clean-list mistakes. The two
consecutive list cues retain one combined meaning rather than two unrelated
sentences. This demonstrates that source/context editing can help this sample;
it does not show that editing alone repairs the upstream cue timestamps.

- Fastest candidate: **3.5-flash-lite**. It repairs major meanings in roughly
  2.2-2.4 seconds per ten cues, but round 1 still says "bão hòa đến phát cuồng"
  and round 3 says "bão hòa điên cuồng". These are awkward for market saturation.
  It also changes "we" to "chúng ta" in cue 260; referent consistency needs review.
- More natural candidate in this sample: **3.1-flash-lite**. Its cue 208 becomes
  "chúng tôi tự làm khó mình ... thị trường đã quá bão hòa", which is more natural
  while retaining the meaning. The 12.25-second second attempt matters for a
  rolling pipeline. Cue 215 remains an awkward fragment ("mức độ chuyên sâu
  của thông tin"); this is not publication-ready editing.
- **2.5-flash** is slower without a clear quality win: "bão hòa đến điên rồ"
  and "mức độ thông tin chi tiết" remain literal. The one successful preview
  response has good market wording, but its latency/errors prevent choosing it
  for this measured low-latency use case.
- Do not select 3.8/3.7/latest from this run: they returned no usable output.
  The error explicitly reports high demand. This is a point-in-time observation
  on this key/endpoint, not a permanent claim about these models.

Start with 3.5-flash-lite as an experimental speed candidate and compare
3.1-flash-lite when naturalness is more important. A future production decision
needs broader consecutive-cue batches, terminology/name checks, and an actual
playback test to account for edit latency and buffer requirements.

Full prompt, inputs, outputs, timings, errors and usage:
`artifacts/translation-edit-probe-2026-10-05.json`.
