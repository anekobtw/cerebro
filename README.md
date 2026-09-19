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

Create and install that build once per device. Run these commands after `npm ci`; do not run `npx eas`, which resolves an unrelated `eas` package instead of Expo's CLI.

```sh
cd apps/mobile
npx --yes eas-cli@24.7.0 login
npx --yes eas-cli@24.7.0 init --account kharitonovs-team --non-interactive
npx --yes eas-cli@24.7.0 build --profile development --platform android
```

Install the APK from the EAS build link on the Android device. Then return to the repository root and start Metro:

```sh
npm run dev:mobile
```

Open the installed Blind Maps development app and scan the displayed QR code. Rebuild and reinstall the APK after changing a native dependency or Expo config/plugin; TypeScript-only changes only require restarting Metro.

## Continuous Expo updates

`.github/workflows/expo-ota.yml` publishes an EAS Update to the `production` branch after every push that changes `apps/**`. Before the workflow can publish or a device can receive updates, configure the Expo project once:

```sh
cd apps/mobile
npx --yes eas-cli@24.7.0 login
npx --yes eas-cli@24.7.0 init --account kharitonovs-team --non-interactive
npx --yes eas-cli@24.7.0 update:configure
npx --yes eas-cli@24.7.0 build --profile development --platform android
```

`init` creates and records the EAS project ID in `app.json`; `update:configure` adds the update URL and runtime-version policy. Commit those `app.json` changes before installing the newly built APK on the phone. In the GitHub repository, add an `EXPO_TOKEN` Actions secret created with `npx --yes eas-cli@24.7.0 token:create`.

The installed development build is pinned to the `production` update channel. On its next launch or reload after a successful workflow, it downloads a compatible JavaScript/assets update; reopen it once more if Expo downloads the update in the background. Native dependency, Expo config/plugin, permission, runtime-version, or SDK changes are not OTA-compatible and require another APK build and install.

## Commands

```sh
npm run dev:mobile
npm run typecheck
npm test
```

