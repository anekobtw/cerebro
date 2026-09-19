import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { AudioManager } from "react-native-audio-api";
import type { CameraView } from "expo-camera";
import type { NavigationPhase, PlaceCandidate, ProviderMode } from "@blind-maps/contracts";
import type { GuidanceLocation } from "@blind-maps/navigation";
import { SpeechOutput } from "../audio/speech-output";
import { EchoGuard } from "../audio/echo-guard";
import { MicrophoneStream, type MicrophoneStats } from "../audio/microphone";
import { PcmPlayer, type PlayerStats } from "../audio/player";
import { FrameCaptureLoop, type FrameCaptureStats } from "../camera/frame-capture";
import type { CameraFrame } from "../camera/types";
import { sceneChanged, sceneSignature } from "../camera/scene-difference";
import { LocationTracker, type LocationStats } from "../location/tracking";
import type { LocationSample } from "../location/types";
import { DynamicNavigator, type DestinationSearchResult } from "../navigation/navigator";
import { ElevenLabsRealtimeClient } from "../providers/elevenlabs-realtime";
import { describeScene, SceneRequestError } from "../providers/gemini-scene";
import { providerConfig } from "../providers/config";
import { speechSampleRateHz } from "../providers/elevenlabs-tts";
import { monotonicNowMs } from "./clock";
export type ConnectionState = "idle" | "connecting" | "connected" | "failed";

const KEEP_AWAKE_TAG = "blind-maps-navigation";
const FIX_ACCURACY_TARGET_M = 25;
const FIX_WAIT_TIMEOUT_MS = 15_000;
// Scribe commits whole phrases, so "yes please" and "no, the other one" have to
// match as well as a bare word.
const AFFIRMATIVE = /\b(yes|yeah|yep|yup|sure|correct|confirm|go there|take me there|that one)\b/;
const NEXT_OPTION = /\b(no|nope|next|another|different|something else|other one)\b/;
export interface NavigationSessionSnapshot {
  destination: string | null;
  audioChunksSent: number;
  framesSent: number;
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
  routeSource: "google_routes" | null;
  routeRequestCount: number;
  routeFallbackReason: null;
  routeFailureDetail: string | null;
  providerWarnings: string[];
  lastAssistantText: string | null;
  lastUserText: string | null;
  lastError: string | null;
}

export interface NavigationSessionControllerOptions {
  getCamera(): CameraView | null;
  onSnapshot(snapshot: NavigationSessionSnapshot): void;
}

export class NavigationSessionController {
  private active = false;
  private paused = false;
  private destination: string | null = null;
  private listeningForDestination = false;
  private destinationRevision = 0;
  private status = "Not connected";
  private connection: ConnectionState = "idle";
  private lastError: string | null = null;
  private lastAssistantText: string | null = null;
  private lastUserText: string | null = null;
  private lastFrameAtMs: number | null = null;
  private framesSent = 0;
  private audioChunksSent = 0;
  private generation = 0;
  private speechGeneration = 0;
  private speaking = false;
  private speechFailed = false;
  private busy = false;
  private previousFrame: Float32Array | null = null;
  private analysisAbort: AbortController | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private connectReject: ((error: Error) => void) | null = null;
  private pendingCandidate: PlaceCandidate | null = null;
  private awaitingConfirmation = false;
  private announcing = false;
  private pendingAnnouncement: string | null = null;
  private rerouting = false;
  private lastLocation: LocationSample | null = null;
  private deviceHeadingDeg: number | null = null;
  private readonly echoGuard = new EchoGuard();
  private readonly navigator = new DynamicNavigator();
  private readonly location = new LocationTracker({
    onSample: (sample) => this.handleLocationSample(sample),
    onOrientation: (sample) => {
      this.deviceHeadingDeg = sample.trueHeadingDeg ?? sample.magneticHeadingDeg;
    },
  });
  private readonly recognizer = new ElevenLabsRealtimeClient();
  private readonly player: PcmPlayer;
  private readonly speech: SpeechOutput;
  private readonly microphone: MicrophoneStream;
  private readonly camera: FrameCaptureLoop;

  constructor(private readonly options: NavigationSessionControllerOptions) {
    this.player = new PcmPlayer({ onStats: () => this.publish() });
    this.speech = new SpeechOutput({
      onActivity: (speaking) => this.echoGuard.setLocalSpeech(speaking, monotonicNowMs()),
      onAudio: (audio, generation) => {
        const bytes = new Uint8Array(audio.bytes);
        const samples = new Int16Array(bytes.length / 2);
        const view = new DataView(bytes.buffer);
        for (let i = 0; i < samples.length; i += 1) samples[i] = view.getInt16(i * 2, true);
        const result = this.player.playSamples({
          utteranceId: `speech-${generation}`, epoch: this.player.epoch,
          samples, sampleRateHz: audio.sampleRateHz,
        });
        if (result !== "queued") throw new Error(`Speech playback failed: ${result}`);
      },
      onError: (message) => { this.speechFailed = true; this.lastError = message; this.player.stop(); this.publish(); },
    });
    this.microphone = new MicrophoneStream({
      onChunk: (chunk) => {
        if (!this.active || this.connection !== "connected") return;
        if (this.recognizer.bufferedAmountBytes > 128_000) {
          void this.fail("Speech recognition upload stalled. Start the assistant again.");
          return;
        }
        try {
          // Once commands are exact matches, keep listening during playback too.
          const filtered = this.destination ? chunk : this.echoGuard.filter(chunk, this.player.queuedMs, monotonicNowMs());
          this.recognizer.sendAudio(filtered.pcmBase64);
          this.audioChunksSent += 1;
        } catch (error) { void this.fail(String(error)); }
      },
      onStats: () => this.publish(),
      onError: (message) => { void this.fail(message); },
    });
    this.camera = new FrameCaptureLoop({
      getCamera: options.getCamera,
      canCapture: () => this.active && !this.paused && !!this.destination && !this.busy && !this.speaking,
      onFrame: (frame) => { void this.processFrame(frame); },
      onStats: () => this.publish(),
    });
  }

  getSnapshot(): NavigationSessionSnapshot {
    return {
      active: this.active, paused: this.paused, destination: this.destination,
      status: this.status, connection: this.connection,
      provider: this.active ? "gemini_text_elevenlabs" : null,
      audioChunksSent: this.audioChunksSent, framesSent: this.framesSent,
      frameAgeMs: this.lastFrameAtMs === null ? null : Math.round(monotonicNowMs() - this.lastFrameAtMs),
      microphone: this.microphone.getStats(), playback: this.player.getStats(),
      camera: this.camera.getStats(), location: this.location.getStats(),
      routeId: this.navigator.routeId, routeVersion: null,
      routeAvailable: this.navigator.activeRoute !== null,
      navigationPhase: this.navigator.phase,
      currentSegmentId: this.navigator.currentStepId,
      routeSource: this.navigator.activeRoute === null ? null : "google_routes",
      routeRequestCount: this.navigator.routeRequestCount,
      routeFallbackReason: null,
      routeFailureDetail: this.navigator.lastFailureDetail,
      providerWarnings: this.navigator.warnings,
      lastAssistantText: this.lastAssistantText, lastUserText: this.lastUserText, lastError: this.lastError,
    };
  }

  async start(cameraPermissionGranted: boolean): Promise<void> {
    if (this.active) return;
    this.active = true;
    const generation = ++this.generation;
    this.paused = false;
    this.destination = null;
    this.pendingCandidate = null;
    this.awaitingConfirmation = false;
    this.pendingAnnouncement = null;
    this.navigator.reset();
    this.previousFrame = null;
    this.lastError = null;
    this.lastUserText = null;
    this.lastAssistantText = null;
    this.framesSent = 0;
    this.audioChunksSent = 0;
    this.connection = "connecting";
    this.status = "Connecting";
    this.publish();
    try {
      if (!cameraPermissionGranted) throw new Error("Camera permission is needed.");
      void providerConfig.geminiApiKey;
      void providerConfig.elevenLabsApiKey;
      void providerConfig.elevenLabsVoiceId;
      void providerConfig.elevenLabsTtsModelId;
      speechSampleRateHz();
      AudioManager.setAudioSessionOptions({
        iosCategory: "playAndRecord",
        iosMode: "voiceChat",
        iosOptions: ["defaultToSpeaker", "allowBluetoothHFP"],
      });
      AudioManager.observeAudioInterruptions("gain");
      await AudioManager.setAudioSessionActivity(true);
      await activateKeepAwakeAsync(KEEP_AWAKE_TAG);
      if (generation !== this.generation) return;
      // Started before the speech connection so a fix has time to settle while
      // the user is still being asked where they want to go.
      await this.location.start();
      if (generation !== this.generation) return;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Speech recognition connection timed out")), 15_000);
        this.connectReject = (error) => { clearTimeout(timeout); reject(error); };
        this.recognizer.connect({
          onReady: () => { clearTimeout(timeout); this.connectReject = null; resolve(); },
          onTranscript: (text) => { if (generation === this.generation) void this.handleTranscript(text); },
          onError: (message) => {
            clearTimeout(timeout);
            reject(new Error(message));
            if (generation === this.generation) void this.fail(message);
          },
          onClose: () => {
            clearTimeout(timeout);
            reject(new Error("Speech recognition disconnected"));
            if (generation === this.generation) void this.fail("Speech recognition disconnected. Start the assistant again.");
          },
        });
      });
      if (generation !== this.generation) return;
      this.connection = "connected";
      await this.microphone.start();
      if (generation !== this.generation) return;
      if (!this.microphone.getStats().running) throw new Error("Microphone unavailable");
      this.timer = setInterval(() => this.publish(), 250);
      await this.repeat();
    } catch (error) {
      if (generation === this.generation) await this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  private async handleTranscript(text: string): Promise<void> {
    if (!this.active) return;
    const command = text.toLowerCase().replace(/[.,!?]/g, "").replace(/\s+/g, " ").trim();
    this.lastUserText = text.trim();
    if (command === "stop") { await this.end(); return; }
    if (command === "pause") { await (this.paused ? this.resume() : this.pause()); return; }
    if (command === "repeat") { await this.repeat(); return; }
    if (command === "change destination" || command === "new destination") {
      await this.promptForDestination();
      return;
    }
    if (this.paused) return;
    if (command === "where am i" || command === "which way") { await this.announcePosition(); return; }
    if (this.awaitingConfirmation) { await this.handleConfirmation(command); return; }
    if (this.destination) return;
    if (!this.listeningForDestination || !text.trim()) return;
    this.listeningForDestination = false;
    await this.resolveDestination(destinationQuery(text));
  }

  private async resolveDestination(query: string): Promise<void> {
    const generation = this.generation;
    const revision = this.destinationRevision;
    if (!query) { await this.promptForDestination(); return; }
    if (!this.navigator.configured) {
      await this.say("Destination search is not set up on this phone.");
      if (this.stale(generation, revision)) return;
      await this.promptForDestination();
      return;
    }

    await this.say(`Finding ${query}.`);
    if (this.stale(generation, revision)) return;
    const origin = await this.waitForFix();
    if (this.stale(generation, revision)) return;
    if (!origin) {
      await this.say("I cannot get a location fix yet. Try again with a clearer view of the sky.");
      if (this.stale(generation, revision)) return;
      await this.promptForDestination();
      return;
    }

    this.status = `Searching for ${query}`;
    this.publish();
    const result = await this.navigator.search(query, origin);
    if (this.stale(generation, revision)) return;
    await this.offerCandidate(result, query);
  }

  private async offerCandidate(result: DestinationSearchResult, query: string): Promise<void> {
    const generation = this.generation;
    const revision = this.destinationRevision;
    if (result.kind !== "candidate") {
      const message = result.kind === "error" ? result.message : `I could not find ${query} near you.`;
      if (result.kind === "error") this.lastError = message;
      await this.say(message);
      if (this.stale(generation, revision)) return;
      await this.promptForDestination();
      return;
    }

    this.pendingCandidate = result.candidate;
    this.status = "Confirming the destination";
    const options = result.remaining > 0 ? ", or say next for another option" : "";
    await this.say(`${result.description}. Say yes to go there${options}.`);
    if (this.stale(generation, revision)) return;
    this.awaitingConfirmation = true;
    this.publish();
  }

  private async handleConfirmation(command: string): Promise<void> {
    // A rejection wins when both words land in one phrase, so a "no" is never
    // heard as agreement.
    if (!NEXT_OPTION.test(command)) {
      if (AFFIRMATIVE.test(command)) { await this.startSelectedRoute(); return; }
      await this.say("Say yes to go there, or next for another option.");
      return;
    }

    const generation = this.generation;
    const revision = this.destinationRevision;
    const origin = this.lastLocation;
    this.awaitingConfirmation = false;
    this.pendingCandidate = null;
    if (!origin) { await this.promptForDestination(); return; }
    const result = this.navigator.nextCandidate(origin);
    if (result.kind === "none") {
      await this.say("That was the last place I found.");
      if (this.stale(generation, revision)) return;
      await this.promptForDestination();
      return;
    }
    await this.offerCandidate(result, "");
  }

  private async startSelectedRoute(): Promise<void> {
    const candidate = this.pendingCandidate;
    const origin = this.lastLocation;
    this.awaitingConfirmation = false;
    this.pendingCandidate = null;
    if (!candidate || !origin) { await this.promptForDestination(); return; }

    const generation = this.generation;
    const revision = this.destinationRevision;
    this.status = "Building the route";
    this.publish();
    await this.say("Building the route.", false);
    if (this.stale(generation, revision)) return;
    const result = await this.navigator.start(candidate, origin);
    if (this.stale(generation, revision)) return;
    if (result.kind === "error") {
      this.lastError = result.message;
      await this.say(result.message);
      if (this.stale(generation, revision)) return;
      await this.promptForDestination();
      return;
    }

    this.destination = candidate.name;
    await this.say(result.announcement);
    if (this.stale(generation, revision)) return;
    this.status = "Guiding you";
    this.camera.start();
    this.publish();
  }

  private handleLocationSample(sample: LocationSample): void {
    this.lastLocation = sample;
    if (!this.active || this.paused || this.navigator.activeRoute === null) return;
    const update = this.navigator.handleLocation(sample);
    if (update.announcement) this.announce(update.announcement);
    if (update.offRoute) void this.handleOffRoute(sample);
  }

  private async handleOffRoute(sample: GuidanceLocation): Promise<void> {
    if (this.rerouting) return;
    this.rerouting = true;
    try {
      const result = await this.navigator.reroute(sample);
      if (result.kind === "rerouted" || result.kind === "exhausted") {
        this.announce(result.announcement);
      } else if (result.kind === "error") {
        this.lastError = result.message;
        this.announce(result.message);
      }
    } finally {
      this.rerouting = false;
      this.publish();
    }
  }

  /** Queued behind the scene pass so every camera frame still gets described. */
  private announce(text: string): void {
    this.pendingAnnouncement = text;
    if (!this.announcing) void this.drainAnnouncements();
  }

  private async drainAnnouncements(): Promise<void> {
    this.announcing = true;
    try {
      while (this.pendingAnnouncement !== null && this.active && !this.paused) {
        while ((this.busy || this.speaking) && this.active && !this.paused) {
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
        if (!this.active || this.paused) break;
        const text = this.pendingAnnouncement;
        this.pendingAnnouncement = null;
        await this.say(text);
      }
    } finally {
      this.announcing = false;
    }
  }

  private async announcePosition(): Promise<void> {
    const sample = this.lastLocation;
    if (!sample) { await this.say("I do not have a location fix yet."); return; }
    await this.say(this.navigator.describePosition(sample, this.deviceHeadingDeg));
  }

  private async waitForFix(): Promise<LocationSample | null> {
    const deadline = monotonicNowMs() + FIX_WAIT_TIMEOUT_MS;
    while (this.active && monotonicNowMs() < deadline) {
      const sample = this.lastLocation;
      if (sample && sample.accuracyM !== null && sample.accuracyM <= FIX_ACCURACY_TARGET_M) {
        return sample;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    // A coarse fix still biases the place search usefully, so it beats refusing.
    return this.lastLocation;
  }

  private stale(generation: number, revision: number): boolean {
    return (
      !this.active ||
      this.paused ||
      generation !== this.generation ||
      revision !== this.destinationRevision
    );
  }

  private async processFrame(frame: CameraFrame): Promise<void> {
    if (!this.active || this.paused || !this.destination || this.busy || this.speaking) return;
    this.lastFrameAtMs = frame.capturedAtMonotonicMs;
    const generation = this.generation;
    this.busy = true;
    const abort = new AbortController();
    this.analysisAbort = abort;
    const timeout = setTimeout(() => abort.abort(), 15_000);
    try {
      const signature = sceneSignature(frame.jpegBase64);
      if (!sceneChanged(this.previousFrame, signature)) return;
      this.status = "Checking the scene";
      this.framesSent += 1;
      this.publish();
      const answer = await describeScene(frame, abort.signal);
      clearTimeout(timeout);
      if (generation !== this.generation || abort.signal.aborted || this.paused) return;
      await this.say(answer);
      if (generation !== this.generation || abort.signal.aborted || this.paused) return;
      if (this.speechFailed) throw new Error("Speech playback failed. Retrying the scene.");
      this.previousFrame = signature;
      this.lastError = null;
      this.status = "Watching for scene changes";
    } catch (error) {
      if (generation === this.generation && !this.paused && this.analysisAbort === abort) {
        this.lastError = abort.signal.aborted ? "Scene request timed out" : String(error);
        if (error instanceof SceneRequestError && !error.retryable) {
          this.camera.stop();
          this.status = this.lastError;
          return;
        }
        this.status = "Could not check the scene. Retrying.";
        await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
      }
    } finally {
      clearTimeout(timeout);
      if (this.analysisAbort === abort) { this.analysisAbort = null; this.busy = false; }
      this.publish();
    }
  }

  async pause(): Promise<void> {
    if (!this.active || this.paused) return;
    this.paused = true;
    this.camera.stop();
    this.cancelWork();
    await this.say("Paused.", false);
    this.publish();
  }

  async resume(): Promise<void> {
    if (!this.active || !this.paused) return;
    this.paused = false;
    await this.say("Resumed.", false);
    if (!this.active || this.paused) return;
    this.previousFrame = null;
    if (this.destination) this.camera.start();
    else await this.repeat();
    this.publish();
  }

  async repeat(): Promise<void> {
    if (!this.active) return;
    if (this.navigator.activeRoute !== null && this.destination !== null) {
      this.paused = false;
      await this.announcePosition();
      return;
    }
    await this.promptForDestination();
  }

  async promptForDestination(): Promise<void> {
    if (!this.active) return;
    const generation = this.generation;
    const revision = ++this.destinationRevision;
    this.camera.stop();
    this.cancelWork();
    this.destination = null;
    this.pendingCandidate = null;
    this.awaitingConfirmation = false;
    this.navigator.reset();
    this.previousFrame = null;
    this.lastFrameAtMs = null;
    this.lastUserText = null;
    this.lastError = null;
    this.paused = false;
    this.listeningForDestination = false;
    await this.say("Where do you want to go?");
    if (generation !== this.generation || revision !== this.destinationRevision || this.paused) return;
    this.listeningForDestination = true;
    this.status = "Listening for your destination";
    this.publish();
  }

  private async say(text: string, remember = true): Promise<void> {
    this.speech.cancel();
    this.player.interrupt();
    const generation = ++this.speechGeneration;
    this.speaking = true;
    this.speechFailed = false;
    if (remember) this.lastAssistantText = text;
    this.status = text;
    this.publish();
    await this.speech.speak(text);
    // Synthesis finishes before the last queued PCM samples have played.
    while (generation === this.speechGeneration && this.active && this.player.queuedMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    if (generation === this.speechGeneration) this.speaking = false;
  }

  private cancelWork(): void {
    this.analysisAbort?.abort();
    this.analysisAbort = null;
    this.pendingAnnouncement = null;
    this.busy = false;
    this.speechGeneration += 1;
    this.speech.cancel();
    this.player.interrupt();
    this.speaking = false;
  }

  async end(): Promise<void> {
    this.active = false;
    this.generation += 1;
    this.paused = false;
    this.listeningForDestination = false;
    this.cancelWork();
    this.connectReject?.(new Error("Session ended"));
    this.connectReject = null;
    this.recognizer.close();
    this.camera.stop();
    this.location.stop();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.connection = "idle";
    this.status = "Assistant ended";
    await this.microphone.stop();
    await this.player.close();
    AudioManager.observeAudioInterruptions(false);
    try {
      await AudioManager.setAudioSessionActivity(false);
    } catch {
      // The native session may already be gone during activity teardown.
    }
    try {
      await deactivateKeepAwake(KEEP_AWAKE_TAG);
    } catch {
      // Ending on unmount or after the activity is gone rejects here, and the
      // lock has already died with the activity.
    }
    this.publish();
  }

  async dispose(): Promise<void> { await this.end(); }

  private async fail(message: string): Promise<void> {
    if (!this.active) return;
    await this.end();
    this.lastError = message;
    this.status = message;
    this.connection = "failed";
    this.publish();
  }

  private publish(): void { this.options.onSnapshot(this.getSnapshot()); }
}

const DESTINATION_PREFIX =
  /^(?:please\s+)?(?:can you\s+|could you\s+)?(?:i (?:want|need|would like) to (?:go|get) to|take me to|navigate to|directions to|walk me to|guide me to|get me to|go to|take me|find)\s+/i;

function destinationQuery(text: string): string {
  const trimmed = text.trim().replace(/[.!?]+$/, "").trim();
  const stripped = trimmed.replace(DESTINATION_PREFIX, "").trim();
  return stripped || trimmed;
}
