# Mobile media checks

Phase 1 checks for the microphone, speaker, camera, and GPS. Nothing here has run on the Pixel yet, because the Android development build has not been produced. Fill in every result below from the device, not from a laptop.

Open the app, tap **Developer diagnostics**, then **Run all audio checks**. The run takes about thirty seconds and drives the same modules the session client will use.

## Audio chain, plan section 5.2

| # | Check | How it is judged | Result |
| --- | --- | --- | --- |
| 1 | Play a locally generated test buffer | By ear: a 440 Hz tone for 0.7 s | not run |
| 2 | Capture ten seconds of mono input | Reports the device sample rate, channel count, and frames per callback | not run |
| 3 | Float to PCM16 with clamping | Automatic: fixed vectors and little-endian byte order | not run |
| 4 | Resample when the capture rate differs | Automatic: error against a reference 300 Hz tone, plus an 11 kHz probe that must not alias down | not run |
| 5 | Deliver 100 ms chunks | Automatic: chunk count over 3 s, 100 ms each, 3,200 bytes each | not run |
| 6 | Play PCM at its declared sample rate | By ear: a 24 kHz tone and a 16 kHz tone must match in pitch and length | not run |
| 7 | Capture and play at the same time | Automatic: microphone peak during speaker playback against the room baseline | not run |
| 8 | Stop playback, reject late chunks, start a new utterance | Automatic: the old epoch is rejected, the new utterance is queued, and the first tone stops instantly | not run |

Checks 3 and 4 also run in `npm test` as unit tests. Running them on the device confirms Hermes agrees with the desktop engine; it does not replace the device audio path checks.

At 16 kHz mono PCM16, one 100 ms chunk is 1,600 samples and 3,200 bytes before base64. Base64 inflates that to 4,268 characters per chunk, about 42 KB/s on the wire.

## Echo cancellation on Android

This is the known risk in the chain, and it is unresolved.

`react-native-audio-api` 0.13.5 opens the Android input through Oboe 1.9.3 with `SharingMode::Exclusive` and `PerformanceMode::LowLatency`, and never calls `setInputPreset`. The stream therefore uses Oboe's default preset rather than `VOICE_COMMUNICATION`, which is the Android input preset that engages the platform echo canceller. The JavaScript API confirms this: `SessionOptions` exposes iOS category, mode, and options, but no Android input preset and no echo-cancellation switch. The package's iOS `voiceChat` mode says nothing about Pixel behavior.

So expect speaker audio to reach the microphone until measured otherwise. Check 7 measures it: it records the room peak for 1.5 s, plays a 2.5 s tone through the speaker, and compares the microphone peak during playback. A ratio above three with a peak above 0.05 fails the check.

If check 7 fails, the options in order of preference:

1. Patch the recorder to request `oboe::InputPreset::VoiceCommunication` and rebuild. This touches a native dependency, so it costs another EAS build and both machines need it.
2. Use a wired or Bluetooth headset for the demo, and say so when presenting.
3. Mute the microphone while the assistant speaks. This is a diagnostic workaround, not the agreed free-conversation behavior, and it must be labelled as such in the demo. Do not report interruption as working on the strength of it.

Switching provider from ElevenLabs to Gemini native audio does not fix this. It is a device-level problem.

Each utterance gets a new native buffer queue. Starting another utterance stops and disconnects the old queue, even when both utterances use the same session epoch. An interruption raises the epoch as well, so a late packet from the cancelled response fails before it can reach the new queue.

## Continuous camera, plan section 5.3

One preview stays mounted and the loop polls every 100 ms. A capture starts only when no capture is in flight and at least one second has passed since the last one started, so a slow capture cannot queue a backlog. `animateShutter` is off and no user action is involved. Only the newest completed frame is kept; replacements are counted in `framesReplaced`. Each temporary file is deleted right after the base64 payload is read, and `temporaryFilesLeft` counts any deletion that failed.

The loop drops a capture that finishes after stop, but still deletes its temporary file. The diagnostics screen suspends capture when the app leaves the foreground and restarts it on return only if the operator had left the loop enabled.

Record from the device:

- Capture duration from `lastCaptureDurationMs`, `medianCaptureDurationMs`, and `slowestCaptureDurationMs`.
- Achieved rate from `captureRateFps` against the 1 FPS ceiling.
- Picture size chosen by `choosePictureSize` (target long edge 768 px) and the encoded size per frame against the 150 KiB budget.
- Whether the entrance sign is readable at that size. Only raise the resolution if it is not.
- Behavior when the app goes to the background and returns.

## Location, plan section 5.3

`watchPositionAsync` runs at `BestForNavigation` with a one second interval. Travel heading comes from GPS course over ground and is null below 0.5 m/s, because Android reports a heading of 0 when standing still. Device heading from `watchHeadingAsync` is reported separately and must never be used as the walking direction. Position timestamps are converted to the phone's monotonic clock at the boundary, so frame and sample ages never mix two clocks.

The tracker ignores callbacks from a stopped run. It also removes a partly started position subscription if heading setup fails or the app moves to the background during startup.

Record `bestAccuracyM`, `worstAccuracyM`, `firstFixDelayMs`, `travelHeadingAvailabilityPercent`, and `lastSampleAgeMs` while walking the route.
