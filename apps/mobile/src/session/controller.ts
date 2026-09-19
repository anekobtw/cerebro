import { AccessibilityInfo } from "react-native";
import * as Speech from "expo-speech";
import * as Haptics from "expo-haptics";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import type { CameraView } from "expo-camera";
import type {
  NavigationPhase,
  ProviderMode,
  RouteManifest,
  UserIntent,
} from "@blind-maps/contracts";
import {
  createNavigationState,
  markArrivalAnnounced,
  navigationProgress,
  reduceNavigation,
  type NavigationEvent,
  type NavigationState,
} from "@blind-maps/navigation";

import { decodeBase64 } from "../audio/base64";
import { MicrophoneStream, type MicrophoneStats } from "../audio/microphone";
import { PcmPlayer, type PlayerStats } from "../audio/player";
import { FrameCaptureLoop, type FrameCaptureStats } from "../camera/frame-capture";
import { LocationTracker, type LocationStats } from "../location/tracking";
import { activeRouteLoadResult } from "../navigation/active-route";
import { selectOutdoorRoute } from "../navigation/google-routes";
import { providerConfig } from "../providers/config";
import { monotonicNowMs } from "./clock";
import { SessionClient, type ConnectionState, type SessionClientSnapshot } from "./client";

const KEEP_AWAKE_TAG = "blind-maps-navigation";

export interface NavigationSessionSnapshot {
  active: boolean;
  paused: boolean;
  status: string;
  connection: ConnectionState;
  provider: ProviderMode | null;
  frameAgeMs: number | null;
  microphone: MicrophoneStats;
  playback: PlayerStats;
  camera: FrameCaptureStats;
  location: LocationStats;
  routeId: string | null;
  routeVersion: number | null;
  routeAvailable: boolean;
  navigationPhase: NavigationPhase | null;
  currentSegmentId: string | null;
  routeSource: "google_routes" | "surveyed" | null;
  routeRequestCount: number;
  routeFallbackReason: string | null;
  routeFailureDetail: string | null;
  providerWarnings: string[];
  lastAssistantText: string | null;
  lastError: string | null;
}

export interface NavigationSessionControllerOptions {
  getCamera(): CameraView | null;
  onSnapshot(snapshot: NavigationSessionSnapshot): void;
}

export class NavigationSessionController {
  private readonly player: PcmPlayer;
  private readonly microphone: MicrophoneStream;
  private readonly camera: FrameCaptureLoop;
  private readonly location: LocationTracker;
  private readonly client: SessionClient;
  private active = false;
  private paused = false;
  private status = "Not connected";
  private connection: ConnectionState = "idle";
  private provider: ProviderMode | null = null;
  private lastFrameAtMs: number | null = null;
  private lastAssistantText: string | null = null;
  private lastError: string | null = null;
  private lastLocationError: string | null = null;
  private frameAgeTimer: ReturnType<typeof setInterval> | null = null;
  private readonly routeManifest: RouteManifest | null =
    activeRouteLoadResult.available ? activeRouteLoadResult.manifest : null;
  private navigationState: NavigationState | null = this.routeManifest
    ? createNavigationState(this.routeManifest)
    : null;
  private routeRequestStarted = false;
  private routeRequestCount = 0;
  private routeFallbackReason: string | null = null;
  private routeFailureDetail: string | null = null;
  private providerWarnings: string[] = [];

  constructor(private readonly options: NavigationSessionControllerOptions) {
    this.player = new PcmPlayer({ onStats: () => this.publish() });
    this.camera = new FrameCaptureLoop({
      getCamera: options.getCamera,
      onFrame: (frame) => {
        this.lastFrameAtMs = frame.capturedAtMonotonicMs;
        this.client.sendFrame(frame);
        this.maybeRequestSceneCheck();
        this.publish();
      },
      onStats: () => this.publish(),
    });
    this.location = new LocationTracker({
      onSample: (sample) => {
        this.client.sendLocation(sample);
        this.dispatchNavigation({ type: "LOCATION", sample });
      },
      onOrientation: (sample) => {
        this.dispatchNavigation({
          type: "ORIENTATION",
          trueHeadingDeg: sample.trueHeadingDeg,
          accuracyLevel: sample.accuracyLevel,
        });
      },
      onStats: (stats) => {
        if (stats.lastError && stats.lastError !== this.lastLocationError) {
          this.lastLocationError = stats.lastError;
          this.lastError = stats.lastError;
          this.status = "Location unavailable";
          void this.announceLocally("Location permission is needed for navigation.");
        }
        this.publish();
      },
    });
    this.microphone = new MicrophoneStream({
      onChunk: (chunk) => {
        this.client.sendAudio(chunk);
      },
      onStats: () => this.publish(),
      onError: (message) => {
        this.lastError = message;
        this.status = "Microphone unavailable";
        void this.announceLocally("Microphone permission is needed for voice assistance.");
        this.publish();
      },
    });
    this.client = new SessionClient({
      onAudio: (pcmBase64, sampleRateHz) => {
        const samples = pcmBytesToInt16(decodeBase64(pcmBase64));
        const utteranceId = `gemini-${this.client.currentEpoch}`;
        this.player.beginUtterance(utteranceId, this.client.currentEpoch);
        this.player.enqueue({
          utteranceId,
          epoch: this.client.currentEpoch,
          sampleRateHz,
          samples,
        });
      },
      onText: (text) => {
        this.lastAssistantText = text;
        this.status = text;
        this.publish();
      },
      onInterrupted: () => {
        this.player.interrupt();
        this.syncNavigationEpoch();
      },
      onIntent: (intent) => void this.handleIntent(intent),
      onObservation: (event) => {
        this.dispatchNavigation({
          type: "OBSERVATION",
          ...event,
          receivedAtMonotonicMs: monotonicNowMs(),
        });
      },
      onSnapshot: (snapshot) => this.handleClientSnapshot(snapshot),
    });
  }

  getSnapshot(): NavigationSessionSnapshot {
    return {
      active: this.active,
      paused: this.paused,
      status: this.status,
      connection: this.connection,
      provider: this.provider,
      frameAgeMs: this.lastFrameAtMs === null ? null : Math.round(monotonicNowMs() - this.lastFrameAtMs),
      microphone: this.microphone.getStats(),
      playback: this.player.getStats(),
      camera: this.camera.getStats(),
      location: this.location.getStats(),
      routeId: this.routeManifest?.id ?? null,
      routeVersion: this.routeManifest?.version ?? null,
      routeAvailable: this.routeManifest !== null,
      navigationPhase: this.navigationState?.phase ?? null,
      currentSegmentId:
        this.navigationState && this.routeManifest
          ? navigationProgress(this.navigationState, this.routeManifest).segmentId
          : null,
      routeSource: this.navigationState?.outdoorRoute?.source ?? null,
      routeRequestCount: this.routeRequestCount,
      routeFallbackReason: this.routeFallbackReason,
      routeFailureDetail: this.routeFailureDetail,
      providerWarnings: [...this.providerWarnings],
      lastAssistantText: this.lastAssistantText,
      lastError: this.lastError,
    };
  }

  async start(cameraPermissionGranted: boolean): Promise<void> {
    if (this.active) return;
    try {
      void providerConfig.geminiApiKey;
      void providerConfig.geminiLiveModel;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.status = this.lastError;
      await this.announceLocally("Gemini is not configured on this development build.");
      this.publish();
      return;
    }
    if (!cameraPermissionGranted) {
      this.lastError = "Camera permission denied";
      this.status = "Camera permission is needed for navigation assistance.";
      await this.announceLocally(this.status);
      this.publish();
      return;
    }
    this.active = true;
    this.paused = false;
    this.status = "Connecting";
    this.lastError = null;
    await activateKeepAwakeAsync(KEEP_AWAKE_TAG);
    this.frameAgeTimer = setInterval(() => this.publish(), 500);
    this.publish();
    try {
      await this.client.start();
    } catch (error) {
      if (!this.active) return;
      const message = error instanceof Error ? error.message : String(error);
      await this.end();
      this.lastError = message;
      this.status = "Connection failed. Check the phone's provider configuration.";
      await this.announceLocally(this.status);
      this.publish();
      return;
    }
    if (!this.active) return;
    this.camera.start();
    await Promise.all([this.microphone.start(), this.location.start()]);
  }

  async pause(announce = true, sendCommand = true): Promise<void> {
    if (!this.active || this.paused) return;
    this.paused = true;
    this.status = "Paused";
    this.camera.stop();
    await Promise.all([this.microphone.stop(), Promise.resolve(this.location.stop())]);
    if (sendCommand) {
      this.player.interrupt();
      const epoch = this.client.command("pause");
      this.dispatchNavigation({ type: "PAUSE", sessionEpoch: epoch }, false);
    } else {
      this.player.stop();
      const epoch = this.client.interrupt();
      this.dispatchNavigation({ type: "PAUSE", sessionEpoch: epoch }, false);
    }
    await deactivateKeepAwake(KEEP_AWAKE_TAG);
    if (announce) await this.announceLocally("Navigation paused.");
    this.publish();
  }

  async resume(sendCommand = true): Promise<void> {
    if (!this.active || !this.paused) return;
    if (this.connection !== "connected") {
      this.status = "Waiting for the provider connection before resuming.";
      this.publish();
      return;
    }
    this.paused = false;
    this.status = "Resuming";
    const epoch = sendCommand
      ? this.client.command("resume")
      : this.client.interrupt();
    this.dispatchNavigation({ type: "RESUME", sessionEpoch: epoch }, false);
    await activateKeepAwakeAsync(KEEP_AWAKE_TAG);
    this.camera.start();
    await Promise.all([this.microphone.start(), this.location.start()]);
    this.publish();
  }

  repeat(sendCommand = true): void {
    if (!this.active) return;
    if (sendCommand) {
      this.player.interrupt();
      this.client.command("repeat");
      this.syncNavigationEpoch();
    } else {
      this.player.stop();
    }
    this.status = "Repeating last guidance";
    this.publish();
  }

  async end(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    this.paused = false;
    this.status = "Navigation ended";
    if (this.frameAgeTimer) clearInterval(this.frameAgeTimer);
    this.frameAgeTimer = null;
    this.camera.stop();
    this.location.stop();
    await this.microphone.stop();
    this.client.stop();
    Speech.stop();
    await this.player.close();
    await deactivateKeepAwake(KEEP_AWAKE_TAG);
    if (this.routeManifest) {
      this.navigationState = createNavigationState(this.routeManifest);
    }
    this.routeRequestStarted = false;
    this.routeRequestCount = 0;
    this.routeFallbackReason = null;
    this.routeFailureDetail = null;
    this.providerWarnings = [];
    this.publish();
  }

  requestDestination(): void {
    if (!this.routeManifest || !this.navigationState) {
      this.status = "No surveyed route is loaded. Scene assistance is still available.";
      void this.announceLocally(this.status);
      this.publish();
      return;
    }
    this.dispatchNavigation({
      type: "REQUEST_DESTINATION",
      destinationId: this.routeManifest.id,
    });
  }

  async confirmDestination(): Promise<void> {
    if (!this.routeManifest || !this.navigationState) return;
    const previousPhase = this.navigationState.phase;
    this.dispatchNavigation({
      type: "CONFIRM_DESTINATION",
      confirmedAtMonotonicMs: monotonicNowMs(),
    });
    if (
      previousPhase === "destination_confirmation" &&
      this.navigationState.phase === "alignment"
    ) {
      await this.prepareOutdoorRoute();
    }
  }

  async dispose(): Promise<void> {
    await this.end();
    if (!this.active) {
      this.client.stop();
      this.camera.stop();
      this.location.stop();
      await this.microphone.stop();
      await this.player.close();
    }
  }

  private handleClientSnapshot(snapshot: SessionClientSnapshot): void {
    const previous = this.connection;
    this.connection = snapshot.connection;
    this.provider = snapshot.provider;
    this.lastError = snapshot.lastError;
    if (snapshot.connection === "connected") {
      if (previous === "reconnecting") {
        this.paused = true;
      }
      this.status = this.paused
        ? "Paused"
        : this.routeManifest
          ? "Connected. Say, take me to the library, to start the surveyed route."
          : "Connected. Scene assistance is ready. No surveyed route is loaded.";
      Speech.stop();
    } else if (snapshot.connection === "reconnecting") {
      this.paused = true;
      this.player.stop();
      this.status = "Connection lost. Guidance paused while reconnecting.";
      if (previous !== "reconnecting") {
        this.camera.stop();
        this.location.stop();
        void this.microphone.stop();
        void this.announceLocally(this.status);
      }
      this.dispatchNavigation(
        { type: "PAUSE", sessionEpoch: snapshot.epoch },
        false,
      );
    } else if (snapshot.connection === "failed") {
      this.player.stop();
      this.status = "Connection failed. End navigation and try again.";
      if (previous !== "failed") {
        this.camera.stop();
        this.location.stop();
        void this.microphone.stop();
        void this.announceLocally(this.status);
      }
    }
    this.publish();
  }

  private async handleIntent(intent: UserIntent): Promise<void> {
    switch (intent.kind) {
      case "request_destination":
        if (!this.routeManifest || !this.navigationState) {
          this.status = "No surveyed route is loaded. I cannot start live guidance.";
          await this.announceLocally(this.status);
          this.publish();
          return;
        }
        this.dispatchNavigation({
          type: "REQUEST_DESTINATION",
          destinationId: intent.destinationId,
        });
        return;
      case "confirm_destination":
        await this.confirmDestination();
        return;
      case "pause":
        await this.pause();
        return;
      case "resume":
        await this.resume();
        return;
      case "repeat":
        this.repeat();
        return;
      case "confirm_vestibule":
        this.dispatchNavigation({
          type: "CONFIRM_INSIDE",
          confirmedAtMonotonicMs: monotonicNowMs(),
        });
        return;
      case "cancel":
        await this.end();
        return;
      case "describe_scene":
        return;
    }
  }

  private async prepareOutdoorRoute(): Promise<void> {
    if (
      this.routeRequestStarted ||
      !this.routeManifest ||
      !this.navigationState?.lastLocation
    ) {
      return;
    }
    this.routeRequestStarted = true;
    const start = this.navigationState.lastLocation;
    const selected = await selectOutdoorRoute({
      enabled: providerConfig.googleRoutesEnabled,
      apiKey: providerConfig.googleMapsApiKey,
      manifest: this.routeManifest,
      start: { latitude: start.latitude, longitude: start.longitude },
      timeoutMs: providerConfig.googleMapsRequestTimeoutMs,
    });
    if (!this.active || !this.navigationState) return;
    this.routeRequestCount = selected.requestCount;
    this.routeFallbackReason = selected.route.fallbackReason ?? null;
    this.routeFailureDetail = selected.rejectionReason;
    this.providerWarnings = selected.route.providerWarnings;
    this.dispatchNavigation({
      type: "SET_OUTDOOR_ROUTE",
      route: selected.route,
    }, false);
    if (selected.route.source === "google_routes") {
      await this.announceLocally(
        "Google walking routes may omit sidewalks or pedestrian paths. This app will use only the surveyed approach.",
      );
    } else if (selected.route.fallbackReason !== "disabled") {
      await this.announceLocally(
        "Google routing was unavailable or did not match the surveyed path. I will use the surveyed route.",
      );
    }
    this.maybeRequestSceneCheck();
    this.publish();
  }

  private dispatchNavigation(
    event: NavigationEvent,
    announce = true,
  ): void {
    if (!this.routeManifest || !this.navigationState) return;
    const previous = this.navigationState;
    const next = reduceNavigation(previous, event, this.routeManifest);
    this.navigationState = next;
    if (next.routeRevision !== previous.routeRevision) {
      this.client.updateNavigation(navigationProgress(next, this.routeManifest));
    }
    if (next.status !== previous.status) {
      this.status = next.status;
      if (next.phase === "arrived") {
        this.navigationState = markArrivalAnnounced(next);
        if (announce) void this.announceLocally(next.status);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } else if (next.paused && !previous.paused) {
        if (this.active && !this.paused) {
          void this.pauseForRouteSafety(next.status);
        } else if (announce) {
          void this.announceLocally(next.status);
        }
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      } else {
        if (announce) void this.announceLocally(next.status);
        void Haptics.selectionAsync();
      }
    }
    this.maybeRequestSceneCheck();
    this.publish();
  }

  private maybeRequestSceneCheck(): void {
    const state = this.navigationState;
    const manifest = this.routeManifest;
    if (!state || !manifest || state.paused) return;
    let allowedAnchorIds: string[] = [];
    if (state.phase === "alignment" && state.outdoorRoute) {
      allowedAnchorIds = [manifest.startAnchorId];
    } else if (state.pendingVisualAnchorId) {
      allowedAnchorIds = [state.pendingVisualAnchorId];
    } else if (
      state.phase === "vestibule_confirmation" &&
      !state.vestibuleEvidenceAnalysisId
    ) {
      allowedAnchorIds = [manifest.arrivalAnchorId];
    }
    if (allowedAnchorIds.length > 0) {
      this.client.requestSceneCheck(state.routeRevision, allowedAnchorIds);
    }
  }

  private syncNavigationEpoch(): void {
    this.dispatchNavigation(
      { type: "SESSION_EPOCH", sessionEpoch: this.client.currentEpoch },
      false,
    );
  }

  private async pauseForRouteSafety(message: string): Promise<void> {
    if (!this.active || this.paused) return;
    this.paused = true;
    this.camera.stop();
    await Promise.all([
      this.microphone.stop(),
      Promise.resolve(this.location.stop()),
    ]);
    this.player.interrupt();
    const epoch = this.client.command("pause");
    this.dispatchNavigation({ type: "PAUSE", sessionEpoch: epoch }, false);
    await deactivateKeepAwake(KEEP_AWAKE_TAG);
    this.status = message;
    await this.announceLocally(message);
    this.publish();
  }

  private async announceLocally(text: string): Promise<void> {
    this.player.stop();
    const screenReader = await AccessibilityInfo.isScreenReaderEnabled();
    if (screenReader) {
      AccessibilityInfo.announceForAccessibility(text);
      return;
    }
    Speech.stop();
    Speech.speak(text, { language: "en-US", rate: 0.95 });
  }

  private publish(): void {
    this.options.onSnapshot(this.getSnapshot());
  }
}

function pcmBytesToInt16(bytes: Uint8Array): Int16Array {
  if (bytes.length % 2 !== 0) throw new Error("PCM16 audio must have an even byte length");
  const samples = new Int16Array(bytes.length / 2);
  for (let index = 0; index < samples.length; index += 1) {
    const value = bytes[index * 2] | (bytes[index * 2 + 1] << 8);
    samples[index] = value >= 0x8000 ? value - 0x10000 : value;
  }
  return samples;
}
