import {
  safetyObservationSchema,
  sceneObservationSchema,
  userIntentSchema,
  type NavigationProgress,
  type SafetyObservation,
  type SceneObservation,
  type UserIntent,
} from "@blind-maps/contracts";

import type { CapturedAudioChunk } from "../audio/types";
import type { CameraFrame } from "../camera/types";
import type { LocationSample } from "../location/types";
import { GeminiLiveClient, type GeminiLiveMessage } from "../providers/gemini-live";
import { monotonicNowMs } from "./clock";
import {
  MAX_PROVIDER_BUFFERED_BYTES,
  MAX_PROVIDER_CONGESTION_MS,
} from "./media-limits";

export type ConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "failed";

export interface SessionClientSnapshot {
  audioChunksSent: number;
  framesSent: number;
  connection: ConnectionState;
  provider: "gemini_text_elevenlabs" | null;
  epoch: number;
  reconnectAttempts: number;
  lastError: string | null;
}

export interface SessionClientOptions {
  onText(text: string): void;
  onUserText?(text: string): void;
  onSpeech(text: string): void;
  onInterrupted(): void;
  onIntent(intent: UserIntent): void;
  onObservation(event: {
    observation: SceneObservation;
    routeRevision: number;
    sessionEpoch: number;
  }): void;
  onSafetyObservation(observation: SafetyObservation): void;
  onSnapshot(snapshot: SessionClientSnapshot): void;
}

const sceneObservationArgumentsSchema = sceneObservationSchema.omit({
  analysisId: true,
  sourceFrameId: true,
  sourceCapturedAtMonotonicMs: true,
});

const safetyObservationArgumentsSchema = safetyObservationSchema.omit({
  analysisId: true,
  sourceFrameId: true,
  sourceCapturedAtMonotonicMs: true,
});

const MAX_RECONNECT_ATTEMPTS = 4;
const CONNECTION_TIMEOUT_MS = 15_000;
const SCENE_ANALYSIS_TIMEOUT_MS = 5_000;
const SAFETY_SCAN_INTERVAL_MS = 2_000;
const EARLY_SPEECH_TARGET_CHARS = 64;
const EARLY_SPEECH_MIN_CHARS = 36;

/** Streams microphone and camera input to Gemini Live and emits text for ElevenLabs speech. */
export class SessionClient {
  private audioChunksSent = 0;
  private framesSent = 0;
  private providerClient: GeminiLiveClient | null = null;
  private paused = false;
  private responseText = "";
  private speechTextBuffer = "";
  private desired = false;
  private state: ConnectionState = "idle";
  private epoch = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingConnectReject: ((error: Error) => void) | null = null;
  private sessionHandle: string | null = null;
  private congestionStartedAtMs: number | null = null;
  private lastError: string | null = null;
  private latestFrame: CameraFrame | null = null;
  private analysisSequence = 0;
  private responseMode: "conversation" | "silent_analysis" = "conversation";
  private awaitingResponse = false;
  private lastSafetyScanAtMs: number | null = null;
  private activeAnalysis: {
    analysisId: string;
    frame: CameraFrame;
    routeRevision: number;
    sessionEpoch: number;
    allowedAnchorIds: string[];
    startedAtMonotonicMs: number;
  } | null = null;
  private activeSafetyAnalysis: {
    analysisId: string;
    frame: CameraFrame;
    startedAtMonotonicMs: number;
  } | null = null;

  constructor(private readonly options: SessionClientOptions) {}

  get currentEpoch(): number {
    return this.epoch;
  }

  get mediaSent(): { audioChunksSent: number; framesSent: number } {
    return { audioChunksSent: this.audioChunksSent, framesSent: this.framesSent };
  }

  async start(): Promise<void> {
    if (this.desired) return;
    this.desired = true;
    this.paused = false;
    this.audioChunksSent = 0;
    this.framesSent = 0;
    await this.connect(false);
  }

  stop(): void {
    this.desired = false;
    this.pendingConnectReject?.(new Error("Gemini Live connection cancelled"));
    this.pendingConnectReject = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const client = this.providerClient;
    this.providerClient = null;
    client?.close();
    this.responseText = "";
    this.speechTextBuffer = "";
    this.state = "idle";
    this.reconnectAttempts = 0;
    this.sessionHandle = null;
    this.congestionStartedAtMs = null;
    this.lastError = null;
    this.latestFrame = null;
    this.activeAnalysis = null;
    this.activeSafetyAnalysis = null;
    this.awaitingResponse = false;
    this.responseMode = "conversation";
    this.lastSafetyScanAtMs = null;
    this.publish();
  }

  sendFrame(frame: CameraFrame): boolean {
    const nowMs = monotonicNowMs();
    const activeAnalysisStartedAtMs =
      this.activeAnalysis?.startedAtMonotonicMs ??
      this.activeSafetyAnalysis?.startedAtMonotonicMs;
    if (
      activeAnalysisStartedAtMs !== undefined &&
      nowMs - activeAnalysisStartedAtMs < SCENE_ANALYSIS_TIMEOUT_MS
    ) {
      return false;
    }
    if (activeAnalysisStartedAtMs !== undefined) {
      this.activeAnalysis = null;
      this.activeSafetyAnalysis = null;
      this.awaitingResponse = false;
      this.responseMode = "conversation";
    }
    if (this.state !== "connected") return false;
    const client = this.providerClient;
    if (!client || client.bufferedAmountBytes > MAX_PROVIDER_BUFFERED_BYTES) return false;
    try {
      client.sendJpegFrame(frame.jpegBase64);
      this.latestFrame = frame;
      this.framesSent += 1;
      return true;
    } catch (error) {
      this.handleSendFailure(client, error);
      return false;
    }
  }

  sendAudio(audio: CapturedAudioChunk): void {
    if (this.state !== "connected" || this.paused) return;
    const client = this.providerClient;
    if (!client) return;

    const nowMs = monotonicNowMs();
    if (client.bufferedAmountBytes > MAX_PROVIDER_BUFFERED_BYTES) {
      this.congestionStartedAtMs ??= nowMs;
      if (nowMs - this.congestionStartedAtMs >= MAX_PROVIDER_CONGESTION_MS) {
        this.lastError = "Gemini Live audio upload remained congested";
        this.scheduleReconnect(this.lastError);
      }
      return;
    } else {
      this.congestionStartedAtMs = null;
    }

    try {
      client.sendPcmAudio(audio.pcmBase64);
      this.audioChunksSent += 1;
    } catch (error) {
      this.handleSendFailure(client, error);
    }
  }

  sendLocation(_location: LocationSample): void {
    // Route progress stays on the phone.
  }

  updateNavigation(progress: NavigationProgress): void {
    const client = this.providerClient;
    if (this.state !== "connected" || !client) return;
    client.sendContext(
      [
        "Application navigation state update. Do not speak only because of this update.",
        `phase=${progress.phase}`,
        `paused=${progress.paused}`,
        `segment=${progress.segmentId ?? "none"}`,
        `instruction=${progress.instructionId ?? "none"}`,
        `routeRevision=${progress.routeRevision}`,
      ].join(" "),
    );
  }

  requestSceneCheck(routeRevision: number, allowedAnchorIds: string[]): boolean {
    const client = this.providerClient;
    const frame = this.latestFrame;
    if (
      this.state !== "connected" ||
      !client ||
      !frame ||
      this.activeAnalysis ||
      this.activeSafetyAnalysis ||
      this.awaitingResponse
    ) {
      return false;
    }
    this.analysisSequence += 1;
    this.activeAnalysis = {
      analysisId: `scene-${this.analysisSequence}`,
      frame,
      routeRevision,
      sessionEpoch: this.epoch,
      allowedAnchorIds: [...allowedAnchorIds],
      startedAtMonotonicMs: monotonicNowMs(),
    };
    this.responseMode = "silent_analysis";
    this.awaitingResponse = true;
    this.responseText = "";
    this.speechTextBuffer = "";
    client.sendUserTurn(
      [
        "Check the most recent camera frame for the current route anchor.",
        `Allowed anchor ids: ${allowedAnchorIds.join(", ")}.`,
        "Call report_scene_observation once. Do not infer a clear walking path.",
      ].join(" "),
    );
    return true;
  }

  requestSafetyCheck(): boolean {
    const client = this.providerClient;
    const frame = this.latestFrame;
    const nowMs = monotonicNowMs();
    if (
      this.state !== "connected" ||
      this.paused ||
      !client ||
      !frame ||
      this.activeAnalysis ||
      this.activeSafetyAnalysis ||
      this.awaitingResponse ||
      (this.lastSafetyScanAtMs !== null && nowMs - this.lastSafetyScanAtMs < SAFETY_SCAN_INTERVAL_MS)
    ) {
      return false;
    }

    this.analysisSequence += 1;
    this.lastSafetyScanAtMs = nowMs;
    this.activeSafetyAnalysis = {
      analysisId: `safety-${this.analysisSequence}`,
      frame,
      startedAtMonotonicMs: nowMs,
    };
    this.responseMode = "silent_analysis";
    this.awaitingResponse = true;
    this.responseText = "";
    this.speechTextBuffer = "";
    client.sendUserTurn(
      [
        "Automatic obstacle scan. Inspect the most recent camera frame.",
        "Call report_safety_observation once and do not speak.",
        "Report only physical obstacles in the user's likely walking path.",
        "Use unknown when the camera is blocked or the walking path cannot be judged.",
        "Never report that the path is safe or clear beyond what is visible.",
      ].join(" "),
    );
    return true;
  }

  command(command: "pause" | "resume" | "repeat" | "cancel"): number {
    this.epoch += 1;
    this.responseText = "";
    this.speechTextBuffer = "";
    if (command === "pause" || command === "cancel") this.paused = true;
    if (command === "resume") this.paused = false;
    this.activeAnalysis = null;
    this.activeSafetyAnalysis = null;
    this.awaitingResponse = false;
    this.responseMode = "conversation";
    const client = this.providerClient;
    if (this.state === "connected" && client) {
      const prompts = {
        resume: "Resume scene assistance. Ask what help I need.",
        repeat: "Repeat your last answer in the same short wording.",
      } as const;
      try {
        if (command === "resume" || command === "repeat") {
          this.awaitingResponse = true;
          this.responseMode = "conversation";
          client.sendUserTurn(prompts[command]);
        }
      } catch (error) {
        this.handleSendFailure(client, error);
      }
    }
    this.publish();
    return this.epoch;
  }

  interrupt(): number {
    this.epoch += 1;
    this.responseText = "";
    this.speechTextBuffer = "";
    this.activeAnalysis = null;
    this.publish();
    return this.epoch;
  }

  private connect(reconnecting: boolean): Promise<void> {
    this.state = reconnecting ? "reconnecting" : "connecting";
    this.lastError = null;
    this.publish();

    return new Promise((resolve, reject) => {
      const client = new GeminiLiveClient();
      this.providerClient = client;
      let settled = false;
      const connectionTimeout = setTimeout(() => {
        failConnection("Gemini Live setup timed out");
      }, CONNECTION_TIMEOUT_MS);

      const failInitialConnection = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectionTimeout);
        this.pendingConnectReject = null;
        this.lastError = message;
        reject(new Error(message));
      };

      this.pendingConnectReject = (error) => failInitialConnection(error.message);

      const ready = () => {
        if (client !== this.providerClient || !this.desired) return;
        clearTimeout(connectionTimeout);
        this.state = "connected";
        this.reconnectAttempts = 0;
        this.congestionStartedAtMs = null;
        this.lastError = null;
        this.publish();
        if (!settled) {
          settled = true;
          this.pendingConnectReject = null;
          resolve();
        }
      };
      const failConnection = (message: string) => {
        if (client !== this.providerClient || !this.desired) return;
        this.lastError = message;
        failInitialConnection(message);
        this.scheduleReconnect(message);
      };

      try {
        client.connect({
          onMessage: (message) => {
            if (client !== this.providerClient || !this.desired) return;
            this.handleProviderMessage(message);
            if (message.goAway) client.close();
          },
          onReady: () => {
            ready();
          },
          onClose: () => {
            failConnection(this.lastError ?? "Gemini Live connection closed");
          },
          onError: () => {
            failConnection("Gemini Live connection failed");
          },
          onProtocolError: (error) => {
            if (client !== this.providerClient || !this.desired) return;
            failConnection(`Invalid Gemini Live message: ${error.message}`);
          },
        }, { sessionHandle: this.sessionHandle });
      } catch (error) {
        clearTimeout(connectionTimeout);
        const message = error instanceof Error ? error.message : String(error);
        failConnection(message);
      }
    });
  }

  private handleProviderMessage(message: GeminiLiveMessage): void {
    const resumption = message.sessionResumptionUpdate;
    if (resumption?.resumable && resumption.newHandle) {
      this.sessionHandle = resumption.newHandle;
    }

    if (message.serverContent?.interrupted && !this.paused) {
      const replacementTurnPending =
        this.awaitingResponse && this.responseMode === "conversation";
      this.responseText = "";
      this.speechTextBuffer = "";
      this.activeAnalysis = null;
      this.activeSafetyAnalysis = null;
      this.awaitingResponse = replacementTurnPending;
      this.responseMode = "conversation";
      this.epoch += 1;
      this.options.onInterrupted();
      this.publish();
    }

    if (!this.paused && message.toolCall?.functionCalls) {
      this.handleToolCalls(message.toolCall.functionCalls);
    }

    const userTranscript = message.serverContent?.inputTranscription?.text?.trim();
    if (!this.paused && userTranscript) {
      this.options.onUserText?.(userTranscript);
      this.awaitingResponse = true;
      this.responseMode = "conversation";
    }

    // Native Live models require AUDIO output. Use only their transcript;
    // ElevenLabs synthesizes the answer and Gemini PCM never reaches playback.
    if (!this.paused && this.responseMode === "conversation") {
      const transcript = message.serverContent?.outputTranscription?.text;
      if (transcript) {
        this.responseText += transcript;
        this.speechTextBuffer += transcript;
        this.options.onText(this.responseText.trim());
        this.flushSpeechText(false);
      }
      if (message.serverContent?.turnComplete) {
        this.flushSpeechText(true);
        this.responseText = "";
      }
    }
    if (message.serverContent?.turnComplete) {
      this.awaitingResponse = false;
      this.responseMode = "conversation";
      this.activeAnalysis = null;
      this.activeSafetyAnalysis = null;
    }
  }

  private handleToolCalls(
    calls: Array<{ id?: string; name?: string; args?: unknown }>,
  ): void {
    const client = this.providerClient;
    if (!client) return;
    const responses: Array<{
      id?: string;
      name: string;
      response: Record<string, unknown>;
    }> = [];

    for (const call of calls) {
      const name = call.name ?? "unknown";
      if (name === "report_user_intent") {
        const parsed = userIntentSchema.safeParse(call.args);
        if (parsed.success) {
          this.options.onIntent(parsed.data);
          responses.push({
            id: call.id,
            name,
            response: { reported: true },
          });
        } else {
          responses.push({
            id: call.id,
            name,
            response: { accepted: false, reason: "Invalid user intent" },
          });
        }
        continue;
      }

      if (name === "report_scene_observation") {
        const analysis = this.activeAnalysis;
        const parsed = sceneObservationArgumentsSchema.safeParse(call.args);
        const hasUnknownAnchor =
          parsed.success &&
          parsed.data.candidateAnchorIds.some(
            (anchorId) => !analysis?.allowedAnchorIds.includes(anchorId),
          );
        if (!analysis || !parsed.success || hasUnknownAnchor) {
          responses.push({
            id: call.id,
            name,
            response: {
              accepted: false,
              reason: hasUnknownAnchor
                ? "Unknown route anchor"
                : "No matching scene check or invalid arguments",
            },
          });
          continue;
        }

        this.activeAnalysis = null;
        this.options.onObservation({
          observation: {
            ...parsed.data,
            analysisId: analysis.analysisId,
            sourceFrameId: analysis.frame.frameId,
            sourceCapturedAtMonotonicMs: analysis.frame.capturedAtMonotonicMs,
          },
          routeRevision: analysis.routeRevision,
          sessionEpoch: analysis.sessionEpoch,
        });
        responses.push({
          id: call.id,
          name,
          response: { reported: true },
        });
        continue;
      }

      if (name === "report_safety_observation") {
        const analysis = this.activeSafetyAnalysis;
        const parsed = safetyObservationArgumentsSchema.safeParse(call.args);
        if (!analysis || !parsed.success) {
          responses.push({
            id: call.id,
            name,
            response: {
              accepted: false,
              reason: "No matching obstacle scan or invalid arguments",
            },
          });
          continue;
        }

        this.activeSafetyAnalysis = null;
        this.options.onSafetyObservation({
          ...parsed.data,
          analysisId: analysis.analysisId,
          sourceFrameId: analysis.frame.frameId,
          sourceCapturedAtMonotonicMs: analysis.frame.capturedAtMonotonicMs,
        });
        responses.push({
          id: call.id,
          name,
          response: { recorded: true, doNotSpeak: true },
        });
        continue;
      }

      responses.push({
        id: call.id,
        name,
        response: { accepted: false, reason: "Unknown tool" },
      });
    }

    try {
      client.sendToolResponses(responses);
    } catch (error) {
      this.handleSendFailure(client, error);
    }
  }

  private scheduleReconnect(message: string): void {
    const client = this.providerClient;
    this.providerClient = null;
    client?.close();
    this.responseText = "";
    this.speechTextBuffer = "";
    this.awaitingResponse = false;
    this.responseMode = "conversation";
    this.paused = true;
    if (!this.desired) return;
    this.lastError = message;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.state = "failed";
      this.publish();
      return;
    }

    this.state = "reconnecting";
    this.reconnectAttempts += 1;
    this.epoch += 1;
    this.activeAnalysis = null;
    this.activeSafetyAnalysis = null;
    this.publish();
    const delayMs = Math.min(1_000 * 2 ** (this.reconnectAttempts - 1), 8_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect(true).catch(() => undefined);
    }, delayMs);
  }

  private handleSendFailure(client: GeminiLiveClient, error: unknown): void {
    if (client !== this.providerClient || !this.desired) return;
    this.lastError = error instanceof Error ? error.message : String(error);
    this.scheduleReconnect(this.lastError);
  }

  private flushSpeechText(final: boolean): void {
    while (this.speechTextBuffer.trim()) {
      const boundary = speechBoundary(this.speechTextBuffer, final);
      if (boundary === null) return;
      const text = this.speechTextBuffer.slice(0, boundary).trim();
      this.speechTextBuffer = this.speechTextBuffer.slice(boundary).trimStart();
      if (text) this.options.onSpeech(text);
    }
  }

  private publish(): void {
    this.options.onSnapshot({
      connection: this.state,
      ...this.mediaSent,
      provider: this.state === "idle" ? null : "gemini_text_elevenlabs",
      epoch: this.epoch,
      reconnectAttempts: this.reconnectAttempts,
      lastError: this.lastError,
    });
  }
}

function speechBoundary(text: string, final: boolean): number | null {
  const sentenceMatch = /[.!?](?:\s|$)/.exec(text);
  if (sentenceMatch) return sentenceMatch.index + 1;
  if (final) return text.length;
  if (text.length < EARLY_SPEECH_TARGET_CHARS) return null;

  const preferredBoundary = text.lastIndexOf(" ", EARLY_SPEECH_TARGET_CHARS);
  if (preferredBoundary >= EARLY_SPEECH_MIN_CHARS) return preferredBoundary + 1;

  const nextBoundary = text.indexOf(" ", EARLY_SPEECH_TARGET_CHARS);
  return nextBoundary >= 0 ? nextBoundary + 1 : null;
}
