# Provider check

## Local direct-client configuration

The Pixel connects directly to Gemini Live and ElevenLabs. There is no deployed backend, proxy, or application WebSocket gateway.

Copy `apps/mobile/.env.example` to `apps/mobile/.env`, then create and paste the provider credentials:

- Gemini: create an API key at <https://aistudio.google.com/apikey>. Set a strict project budget and API-key restrictions before using it on the phone.
- ElevenLabs: create an API key in the ElevenLabs dashboard and set a credit limit. The documented interactive CLI login is `elevenlabs auth login`; it stores credentials locally for the CLI and does not insert keys into an Expo app. There is no documented dashboard-login API for an application to obtain an API key.

`EXPO_PUBLIC_*` values are embedded in the mobile application bundle. The direct-client choice exposes Gemini and ElevenLabs keys to anyone with the APK. Restrict these keys to the demo project, least permissions, and a hard spending cap. Never reuse personal or production keys.

## Direct API contracts

- Gemini Live: the app opens `BidiGenerateContent` directly with the configured API key, then sends a setup message. Audio is 16-bit little-endian PCM at 16 kHz and camera frames are JPEG base64 payloads.
- ElevenLabs TTS: `POST /v1/text-to-speech/{voice_id}/stream` with `xi-api-key`, configured model, and configured output format.
- ElevenLabs STT: `POST /v1/speech-to-text` with `xi-api-key`, `scribe_v2`, and a 16-bit mono 16 kHz PCM upload.

Provider access, account model availability, actual output formats, latency, and billing remain unverified until tested on the Pixel.
