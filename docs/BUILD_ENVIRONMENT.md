# Build environment

- Node.js: 24.21.0 LTS (use `.nvmrc`)
- npm: 11.19.0
- Package manager: npm workspaces with the committed `package-lock.json`

Run all workspace installs from the repository root.

## Android development build

The app needs a development build. `react-native-audio-api` is a native module and does not run in Expo Go.

Locked native dependencies, all resolved by `npx expo install` against Expo SDK 57:

| Package | Version | Why |
| --- | --- | --- |
| `expo` | 57.0.24 | SDK baseline |
| `react-native` | 0.86.3 | SDK 57 pairing |
| `react-native-audio-api` | 0.13.5 | Microphone PCM capture and queued PCM playback |
| `react-native-worklets` | 0.10.1 | Peer dependency of the audio package; `babel-preset-expo` adds its Babel plugin when installed, so no `babel.config.js` is needed |
| `expo-camera` | 57.0.5 | Frame source for the continuous capture loop |
| `expo-file-system` | 57.0.7 | Deletes each temporary capture file after encoding |
| `expo-location` | 57.0.19 | GPS samples and device heading |

`npx expo-doctor` passes 21/21 checks on this set. `npx expo config --type introspect` applies every config plugin, so the Android permission list and the audio package's foreground-service entry are verified without a build.

Config already committed:

- Android package `com.blindmaps.mobile`.
- Permissions: camera, record audio, modify audio settings, coarse and fine location, plus the foreground-service pair the audio plugin adds.
- `react-native-audio-api` plugin with `androidFSTypes: ["mediaPlayback"]`. The session keeps the screen awake, so background microphone capture is out of scope; adding the `microphone` service type would need `FOREGROUND_SERVICE_MICROPHONE` and another native build.
- `eas.json` pins `cli.version` to `>=24.7.0` (24.7.0 is the version this configuration was written against) and uses `appVersionSource: "remote"`.

Remaining steps, which need an Expo account and are not done yet:

```powershell
Set-Location apps/mobile
npx eas-cli@24.7.0 login
npx eas-cli@24.7.0 build:configure
npx eas-cli@24.7.0 build --platform android --profile development
```

`build:configure` writes `extra.eas.projectId` and an `owner` into `app.json`. Inspect that diff and keep the two existing profiles. Record the queue result and the exact CLI version that produced a working APK here.

Local alternative, only on a machine that already has a compatible JDK and the Android SDK:

```powershell
Set-Location apps/mobile
npx expo run:android --device
```

After the development build is installed, TypeScript edits reload through Metro. Changing a native dependency, a config plugin, or a permission needs a new build on both machines.
