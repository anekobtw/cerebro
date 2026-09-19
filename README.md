# Blind Maps

Hackathon monorepo for the Blind Maps mobile assistant.

## Prerequisites

- Node.js 24.21.0
- npm 11.19.0

## Setup

```sh
npm ci
cp apps/mobile/.env.example apps/mobile/.env
```

## Commands

```sh
npm run dev:mobile
npm run typecheck
npm test
```

The mobile app calls Gemini Live and ElevenLabs directly. `EXPO_PUBLIC_*` values are public configuration embedded in the application bundle, including the intentionally direct provider keys; use only demo-scoped keys with strict spend limits.
