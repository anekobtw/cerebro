# Blind Maps

Hackathon monorepo for the Blind Maps mobile assistant.

## Prerequisites

- Node.js 24.21.0
- npm 11.19.0

## Setup

```sh
npm ci
cp apps/api/.env.example apps/api/.env
cp apps/mobile/.env.example apps/mobile/.env
```

## Commands

```sh
npm run dev:api
npm run dev:mobile
npm run typecheck
npm test
```

The API starts in explicit mock mode by default. Mobile `EXPO_PUBLIC_*` values are public configuration; provider credentials belong only in `apps/api/.env`.