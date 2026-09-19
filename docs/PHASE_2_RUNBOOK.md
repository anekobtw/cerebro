# Phase 2 phone runbook

Phase 2 runs in the Android development build on the Pixel. The app sends microphone and camera input directly to Gemini Live. It does not start or contact a Blind Maps server.

## Configure the development build

Copy `.env.example` to `.env` and set either the existing provider-check names:

```dotenv
GEMINI_API_KEY=development-key
GEMINI_MODEL=gemini-3.8-live
```

or their Expo-public aliases:

```dotenv
EXPO_PUBLIC_GEMINI_API_KEY=development-key
EXPO_PUBLIC_GEMINI_LIVE_MODEL=gemini-3.8-live
```

The local Expo configuration passes either naming style to the development app. The key is therefore present in the app bundle. Use a restricted development key and rotate it when testing ends.

The mobile client enables context-window compression and keeps Gemini's latest resumable session handle. This lets a ten-minute check continue across the provider's connection resets without adding a Blind Maps service.

## Start the app

Connect the Pixel through USB debugging, then run:

```sh
cd apps/mobile
npx expo run:android
```

For later TypeScript changes, start Metro with `npm run dev:mobile` and open the installed development build on the phone.

## Phase 2 checks

On the Pixel 8 Pro, verify:

1. Denying camera, microphone, or location permission produces a spoken local explanation.
2. Starting navigation opens one direct Gemini Live session and begins microphone, camera, and location capture.
3. Automatic camera frames affect an answer about the current scene.
4. Speaking during assistant audio makes Gemini send an interruption event, which stops queued audio before the new reply plays.
5. Pause stops sensor streaming and playback. Resume restarts them.
6. Repeat asks Gemini to repeat the last guidance.
7. A forced provider disconnect pauses the assistant, reconnects with the latest resumable handle, and does not replay old audio.
8. The screen stays awake during an active session.
9. Ending the assistant releases the microphone, camera, location watcher, timers, provider connection, and playback.
10. One logical session remains usable for ten minutes, including a resumable reconnect if the provider resets the socket.

The diagnostics panel reports the provider connection, frame age, microphone state, and audio state. Route guidance stays disabled until `docs/FIELD_SURVEY.md` contains real measurements and the app has a matching local route manifest.

## Current local verification

The TypeScript and Vitest checks cover the shared media helpers, provider wire messages, resumable reconnects, and controller dependencies. Android audio behavior, speaker echo, permissions, and cleanup still require the Pixel. A local native rebuild needs JDK 21. The machine used for the earlier check had JDK 25, which stopped the Android CMake step.
