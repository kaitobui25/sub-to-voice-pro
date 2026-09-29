# Sub-to-Voice Pro

Current MVP: Chrome Manifest V3 subtitle-first dubbing for normal YouTube VOD videos that already have captions.

The implementation follows the locked Echoly subtitle-first baseline recorded in docs/ECHOLY_BASELINE.md. Production settings UI, Realtime/WebRTC, no-caption audio fallback, live streams, streaming TTS, and playback-rate scheduling are deferred.

## Development

1. Copy .env.example to .env and fill local provider keys.
2. Run the development runtime-config generator once provider phases are enabled.
3. Open chrome://extensions, enable Developer mode, choose Load unpacked, and select this folder.
4. Open a normal captioned YouTube VOD.
5. Click the extension action to Start/Stop.

Phase 1 only verifies real caption acquisition and sentence regrouping. The small on-page panel is a temporary debug control, not the production UI.

## Checks

Run npm test and npm run check.

Secrets in .env and generated local runtime config are gitignored.
