# Blind Maps

Hackathon monorepo for the Blind Maps mobile assistant. Development runs locally on a Pixel. The app connects directly to the configured cloud providers and has no Blind Maps backend.

## Prerequisites

- Node.js 24.21.0 and npm 11.19.0.
- A Pixel or Android emulator with USB debugging enabled.
- JDK 21 and the Android SDK for a local development build.

## Setup

```sh
npm ci
cp .env.example .env
```

Set the provider values in the root `.env`. Existing `GEMINI_API_KEY`, `GEMINI_MODEL`, and `ELEVENLABS_*` values work. Their `EXPO_PUBLIC_*` aliases also work. The development app receives these values through Expo configuration, so use restricted development credentials, never commit `.env`, and rotate the credentials after the hackathon.

## Run on Android

The app uses native modules that Expo Go does not include. Build and install the development app on the connected phone:

```sh
cd apps/mobile
npx expo run:android
```

The command builds the debug app, installs it, and starts Metro. After TypeScript-only changes, keep the installed development build and restart Metro from the repository root:

```sh
npm run dev:mobile
```

The phone must reach the laptop running Metro. USB debugging with `adb reverse` is the simplest setup. Rebuild after changing native dependencies, Expo plugins, permissions, or the Expo SDK.

## Checks

```sh
npm run typecheck
npm test
```

See [the phase 2 runbook](docs/PHASE_2_RUNBOOK.md) for the on-phone checks.
