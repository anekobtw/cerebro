import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import type { CameraView } from "expo-camera";
import { SpeechOutput } from "../audio/speech-output";
import { EchoGuard } from "../audio/echo-guard";
import { MicrophoneStream, type MicrophoneStats } from "../audio/microphone";
import { PcmPlayer, type PlayerStats } from "../audio/player";
import { FrameCaptureLoop, type FrameCaptureStats } from "../camera/frame-capture";
import type { CameraFrame } from "../camera/types";
import { sceneChanged, sceneSignature } from "../camera/scene-difference";
import { ElevenLabsRealtimeClient } from "../providers/elevenlabs-realtime";
import { describeScene, SceneRequestError } from "../providers/gemini-scene";
import { providerConfig } from "../providers/config";
import { speechSampleRateHz } from "../providers/elevenlabs-tts";
import { monotonicNowMs } from "./clock";
export type ConnectionState = "idle" | "connecting" | "connected" | "failed";

const KEEP_AWAKE_TAG = "blind-maps-navigation";
export interface NavigationSessionSnapshot {
  destination: string | null;
  audioChunksSent: number;
  framesSent: number;
  active: boolean;
  paused: boolean;
  status: string;
  connection: ConnectionState;
  provider: "gemini_text_elevenlabs" | null;
  frameAgeMs: number | null;
  microphone: MicrophoneStats;
  playback: PlayerStats;
  camera: FrameCaptureStats;
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
  private readonly echoGuard = new EchoGuard();
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
      camera: this.camera.getStats(),
      lastAssistantText: this.lastAssistantText, lastUserText: this.lastUserText, lastError: this.lastError,
    };
  }

  async start(cameraPermissionGranted: boolean): Promise<void> {
    if (this.active) return;
    this.active = true;
    const generation = ++this.generation;
    this.paused = false;
    this.destination = null;
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
      await activateKeepAwakeAsync(KEEP_AWAKE_TAG);
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
    if (command === "end assistant") { await this.end(); return; }
    if (command === "pause") { await (this.paused ? this.resume() : this.pause()); return; }
    if (command === "repeat") { await this.repeat(); return; }
    if (this.destination || this.paused) return;
    if (!this.listeningForDestination || !text.trim()) return;
    this.listeningForDestination = false;
    this.destination = text.trim();
    this.lastUserText = text.trim();
    const generation = this.generation;
    const revision = this.destinationRevision;
    await this.say("The route is built.");
    if (generation !== this.generation || revision !== this.destinationRevision || this.paused) return;
    this.status = "Watching for scene changes";
    this.camera.start();
    this.publish();
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
    const generation = this.generation;
    const revision = ++this.destinationRevision;
    this.camera.stop();
    this.cancelWork();
    this.destination = null;
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
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.connection = "idle";
    this.status = "Assistant ended";
    await this.microphone.stop();
    await this.player.close();
    await deactivateKeepAwake(KEEP_AWAKE_TAG);
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
