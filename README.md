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
cp .env.example .env
```

Configure the mobile `EXPO_PUBLIC_*` values and the separate server-side provider-check values in the root `.env`. Values beginning with `EXPO_PUBLIC_` are embedded in the mobile app; never reuse server credentials in those variables or commit `.env`.

## Android development build

The mobile app uses native modules that are not included in Expo Go. Build and install the development app locally on an Android device or emulator:

```sh
cd apps/mobile
npx expo run:android
```

The local SDK lives at `~/Android/Sdk`; `~/.zprofile` exports `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `JAVA_HOME` (JDK 21), and the required Android tool paths. Open a new terminal before running the command so those settings are loaded.

`npx expo run:android` requires either a USB-debuggable device connected through `adb` or a running Android emulator. It builds a debug APK with the generated `apps/mobile/android` project, installs it on the target, and starts Metro. Re-run it after changing a native dependency or Expo config/plugin; TypeScript-only changes only require restarting Metro:

```sh
npm run dev:mobile
```

## Continuous Expo updates

`.github/workflows/expo-ota.yml` publishes an EAS Update to the `production` channel after every push that changes `apps/**`. Add an `EXPO_TOKEN` Actions secret to the GitHub repository before using the workflow. Store the app's `EXPO_PUBLIC_*` values in the EAS `production` environment. The preview build and OTA workflow both read that environment, so they compile the same provider settings into the app.

Install a preview APK on each hackathon phone. Preview builds launch without Metro and receive updates from the `production` channel:

```sh
cd apps/mobile
npx --yes eas-cli@24.7.0 login
npx --yes eas-cli@24.7.0 build --profile preview --platform android
```

After GitHub Actions publishes an update, force close and reopen the app. Expo may download the update during that launch, so force close and reopen it a second time if the old version appears. JavaScript and asset changes can ship over OTA. Native dependencies, Expo config plugins, permissions, runtime versions, and Expo SDK changes require a new APK.

Use the `development` build profile for local Metro work. A development build opens the Expo developer launcher and does not behave like the standalone preview APK used for OTA testing.

## Commands

```sh
npm run dev:mobile
npm run typecheck
npm test
```

