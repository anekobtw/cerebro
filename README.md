# Blind Maps

Hackathon monorepo for the Blind Maps mobile assistant.

## Prerequisites

- Node.js 24.21.0 and npm 11.19.0. Install this Node.js release through your operating system's package manager or from [nodejs.org](https://nodejs.org/), then verify:

  ```sh
  node --version
  npm --version
  ```

- An Expo account for installing development builds on a physical device.

## Setup

```sh
npm ci
cp apps/mobile/.env.example apps/mobile/.env
```

Populate `apps/mobile/.env` with demo-scoped Gemini and ElevenLabs keys. Values beginning with `EXPO_PUBLIC_` are embedded in the mobile app; never use production or unrestricted keys.

## Android development build

The mobile app uses native modules that are not included in Expo Go. The QR code from `npm run dev:mobile` opens an already-installed Blind Maps development build; it does not install the app.

Create and install that build once per device:

```sh
cd apps/mobile
npx eas login
npx eas build --profile development --platform android
```

Install the APK from the EAS build link on the Android device. Then return to the repository root and start Metro:

```sh
npm run dev:mobile
```

Open the installed Blind Maps development app and scan the displayed QR code. Rebuild and reinstall the APK after changing a native dependency or Expo config/plugin; TypeScript-only changes only require restarting Metro.

## Commands

```sh
npm run dev:mobile
npm run typecheck
npm test
```

