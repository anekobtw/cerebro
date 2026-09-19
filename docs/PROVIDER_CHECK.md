# Provider check

## Experiment

`apps/api/src/provider-check.ts` is a server-side, one-session viability check for the preferred `gemini-robotics-er-2-streaming-preview` plus ElevenLabs path. It keeps provider credentials in `apps/api/.env`; the script never reads mobile `EXPO_PUBLIC_*` values.

The check:

1. Opens a Gemini Live WebSocket session configured for text output.
2. Sends a real 16 kHz, mono, PCM16 utterance and a JPEG scene with library route context.
3. Collects the first completed text response.
4. Sends a different JPEG scene in the same session and fails when the response is empty or unchanged.
5. Sends a short ElevenLabs TTS request in the configured PCM output format, rejects empty output, and records its content type and byte count.
6. Reads the ElevenLabs subscription counters when the account permits it. Gemini streaming pricing is not inferred from another Gemini model; inspect its billing data separately before making a cost claim.

## Running it

```sh
cp apps/api/.env.example apps/api/.env
# Set server-side provider credentials and paths to two different, real scene JPEGs
# plus a real, raw 16 kHz mono PCM16 utterance.
npm run provider:check --workspace @blind-maps/api
```

`PROVIDER_CHECK_MAX_COST_USD` records the operator-approved spend ceiling in the result. It is not a provider-side billing control: configure an actual budget/usage limit in both provider dashboards before running the check.

The JSON result contains model IDs, responses, output format, audio byte count, and available ElevenLabs usage counters. It contains no keys or media bytes.

## Current result

- `npm run typecheck --workspace @blind-maps/api` passes.
- The live provider check has not sent any provider request. It stopped before connection because neither `GEMINI_API_KEY` nor `GOOGLE_API_KEY` is configured in `apps/api/.env`.
- Account availability, Gemini handshake, scene-response relevance, ElevenLabs output, credit usage, and billing remain unverified. If those remain unresolved at the T+1:00 decision gate, configure `gemini_native` rather than extending this experiment.
