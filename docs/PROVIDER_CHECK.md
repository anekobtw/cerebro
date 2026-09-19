# Provider check

## Experiment

`apps/api/src/provider-check.ts` is a server-side viability check for the configured Gemini Live plus ElevenLabs path. It reads provider credentials from the repository-root `.env`; the script never reads mobile `EXPO_PUBLIC_*` values.

The check:

1. Opens one Gemini Live WebSocket session with a structured `report_obstacle` tool.
2. Sends each JPEG and its planned route instruction in the same ordered client turn.
3. Requires one validated obstacle observation per frame: presence, type, position, immediate action, explanation, and confidence.
4. Uploads the configured utterance to ElevenLabs speech-to-text and records the returned transcript and language confidence.
5. Converts the latest obstacle observation into conservative guidance. Low-confidence or inconsistent observations become a stop instruction.
6. Sends that guidance to ElevenLabs TTS, rejects empty output, and records its content type and byte count.
7. Reads the ElevenLabs subscription counters when the account permits it. Provider dashboard budgets remain the actual spending controls.

## Running it

The server-side check uses these environment variables:

- `GEMINI_API_KEY`
- `GEMINI_MODEL`
- `ELEVENLABS_API_KEY`
- `ELEVENLABS_VOICE_ID`
- `ELEVENLABS_TTS_MODEL_ID`
- `ELEVENLABS_TTS_OUTPUT_FORMAT`
- `ELEVENLABS_STT_MODEL_ID`
- `PROVIDER_CHECK_IMAGE_PATH`
- `PROVIDER_CHECK_SECOND_IMAGE_PATH`
- `PROVIDER_CHECK_AUDIO_PATH`
- `PROVIDER_CHECK_MAX_COST_USD`

```sh
cp .env.example .env
# Set server-side provider credentials, paths to two different real scene JPEGs,
# and an audio or video file for ElevenLabs speech-to-text. Raw `.pcm` is sent
# as 16 kHz mono PCM16; encoded input is uploaded in its original container.
npm run provider:check --workspace @blind-maps/api
```

Supported input extensions: `.pcm`, `.aac`, `.aiff`, `.flac`, `.m4a`, `.mp3`, `.ogg`, `.opus`, `.wav`, `.webm`, `.3gp`, `.avi`, `.flv`, `.mkv`, `.mov`, `.mp4`, `.mpeg`, and `.wmv`.

`PROVIDER_CHECK_MAX_COST_USD` records the operator-approved spend ceiling in the result. It is not a provider-side billing control: configure an actual budget/usage limit in both provider dashboards before running the check.

The JSON result contains both structured Gemini obstacle observations, the ElevenLabs transcription, the exact synthesized guidance, TTS output metadata, and available ElevenLabs usage counters. It contains no keys or media bytes.

## Current result

- `npm run typecheck --workspace @blind-maps/api` passes.
- The live provider check completes with `gemini-3.8-live`, ElevenLabs `scribe_v2`, and ElevenLabs `eleven_flash_v2_5`.
- Gemini reports the first scene as unobstructed and identifies a table blocking the second scene with `0.95` confidence. The safety policy converts the second observation to “Obstacle ahead. Stop.” and ElevenLabs returns non-empty PCM audio for that exact guidance.
