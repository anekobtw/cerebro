# Cerebro

Hackathon monorepo for the Cerebro mobile assistant. Development runs locally on a Pixel. The app connects directly to the configured cloud providers and has no Cerebro backend. The Android package was too large to include in the repository.

## Prerequisites

- Node.js 24.21.0 and npm 11.19.0.
- A phone
- JDK 21 and the Android SDK for a local development build.

## Setup

```sh
npm ci
```

Create the root `.env` with restricted development credentials. The file is ignored by Git; never commit it, and rotate its keys after the hackathon.

```dotenv
GEMINI_API_KEY=...

ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...
ELEVENLABS_TTS_MODEL_ID=...
ELEVENLABS_TTS_OUTPUT_FORMAT=pcm_24000

GOOGLE_PLACES_ENABLED=true
GOOGLE_PLACES_REGION=us
GOOGLE_ROUTES_ENABLED=true
GOOGLE_MAPS_API_KEY=...
```

`GEMINI_SCENE_MODEL` is optional and defaults to `gemini-3.5-flash-lite`. `ELEVENLABS_REALTIME_STT_MODEL_ID` is optional and defaults to `scribe_v2_realtime`.

Spoken destination search requires both `GOOGLE_PLACES_ENABLED=true` and `GOOGLE_ROUTES_ENABLED=true`, plus a restricted `GOOGLE_MAPS_API_KEY` with the **Places API** and **Routes API** enabled. The same key serves both APIs. `GOOGLE_PLACES_REGION` is optional country context; keep `us` for US searches or omit it for region-neutral matching.

The remaining Maps/navigation tuning variables are optional. Omit them to use the built-in defaults: a 3,000 m search radius, 5,000 ms Maps request timeout, 30 m arrival radius, at most three reroutes per session, and a 30-second reroute cooldown.

## Run on Android

The app uses native modules that Expo Go does not include. Build and install the development app on the connected phone:

```sh
npx expo run:android
```

The command builds the debug app, installs it, and starts Metro. For later starts, keep the installed development build, leave the phone connected over USB, return to the repository root, and run:

```sh
npm run dev
```

This configures `adb reverse` for Metro on port 8081, starts Expo on an externally reachable listener while advertising the USB-forwarded loopback address, and opens the development client on the connected phone. Rebuild after changing `.env`, native dependencies, Expo plugins, permissions, or the Expo SDK.

