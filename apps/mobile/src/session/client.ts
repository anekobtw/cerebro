import {
  sceneObservationSchema,
  userIntentSchema,
  type NavigationProgress,
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
  connection: ConnectionState;
  provider: "gemini_native" | null;
  epoch: number;
  reconnectAttempts: number;
  lastError: string | null;
}

export interface SessionClientOptions {
  onAudio(pcmBase64: string, sampleRateHz: number): void;
  onText(text: string): void;
  onInterrupted(): void;
  onIntent(intent: UserIntent): void;
  onObservation(event: {
    observation: SceneObservation;
    routeRevision: number;
    sessionEpoch: number;
  }): void;
  onSnapshot(snapshot: SessionClientSnapshot): void;
}

const sceneObservationArgumentsSchema = sceneObservationSchema.omit({
  analysisId: true,
  sourceFrameId: true,
  sourceCapturedAtMonotonicMs: true,
});

const MAX_RECONNECT_ATTEMPTS = 4;
const CONNECTION_TIMEOUT_MS = 15_000;
const SCENE_ANALYSIS_TIMEOUT_MS = 5_000;

/** Owns the phone's direct Gemini Live connection. There is no Blind Maps server. */
export class SessionClient {
  private providerClient: GeminiLiveClient | null = null;
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
  private activeAnalysis: {
    analysisId: string;
    frame: CameraFrame;
    routeRevision: number;
    sessionEpoch: number;
    allowedAnchorIds: string[];
    startedAtMonotonicMs: number;
  } | null = null;

  constructor(private readonly options: SessionClientOptions) {}

  get currentEpoch(): number {
    return this.epoch;
  }

  async start(): Promise<void> {
    if (this.desired) return;
    this.desired = true;
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
    this.state = "idle";
    this.reconnectAttempts = 0;
    this.sessionHandle = null;
    this.congestionStartedAtMs = null;
    this.lastError = null;
    this.latestFrame = null;
    this.activeAnalysis = null;
    this.publish();
  }

  sendFrame(frame: CameraFrame): void {
    this.latestFrame = frame;
    if (
      this.activeAnalysis &&
      monotonicNowMs() - this.activeAnalysis.startedAtMonotonicMs <
        SCENE_ANALYSIS_TIMEOUT_MS
    ) {
      return;
    }
    this.activeAnalysis = null;
    if (this.state !== "connected") return;
    const client = this.providerClient;
    if (!client || client.bufferedAmountBytes > MAX_PROVIDER_BUFFERED_BYTES) return;
    try {
      client.sendJpegFrame(frame.jpegBase64);
    } catch (error) {
      this.handleSendFailure(client, error);
    }
  }

  sendAudio(audio: CapturedAudioChunk): void {
    if (this.state !== "connected") return;
    const client = this.providerClient;
    if (!client) return;

    const nowMs = monotonicNowMs();
    if (client.bufferedAmountBytes > MAX_PROVIDER_BUFFERED_BYTES) {
      this.congestionStartedAtMs ??= nowMs;
      if (nowMs - this.congestionStartedAtMs >= MAX_PROVIDER_CONGESTION_MS) {
        this.lastError = "Gemini Live upload remained congested";
        client.close();
        return;
      }
    } else {
      this.congestionStartedAtMs = null;
    }

    try {
      client.sendPcmAudio(audio.pcmBase64);
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
    client.sendText(
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
    if (this.state !== "connected" || !client || !frame || this.activeAnalysis) {
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
    client.sendText(
      [
        "Check the most recent camera frame for the current route anchor.",
        `Allowed anchor ids: ${allowedAnchorIds.join(", ")}.`,
        "Call report_scene_observation once. Do not infer a clear walking path.",
      ].join(" "),
    );
    return true;
  }

  command(command: "pause" | "resume" | "repeat" | "cancel"): number {
    this.epoch += 1;
    this.activeAnalysis = null;
    const client = this.providerClient;
    if (this.state === "connected" && client) {
      const prompts = {
        resume: "Resume scene assistance. Ask what help I need.",
        repeat: "Repeat your last answer in the same short wording.",
      } as const;
      try {
        if (command === "pause") {
          client.endAudioStream();
        } else if (command !== "cancel") {
          client.sendText(prompts[command]);
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
        failInitialConnection("Gemini Live setup timed out");
        client.close();
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

      try {
        client.connect({
          onMessage: (message) => {
            if (client !== this.providerClient || !this.desired) return;
            this.handleProviderMessage(message);
            if (message.goAway) client.close();
          },
          onReady: () => {
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
          },
          onClose: () => {
            if (client !== this.providerClient || !this.desired) return;
            clearTimeout(connectionTimeout);
            failInitialConnection("Gemini Live closed before setup completed");
            this.scheduleReconnect(this.lastError ?? "Gemini Live connection closed");
          },
          onError: () => {
            if (client !== this.providerClient || !this.desired) return;
            failInitialConnection("Gemini Live connection failed");
            client.close();
          },
          onProtocolError: (error) => {
            if (client !== this.providerClient || !this.desired) return;
            failInitialConnection(`Invalid Gemini Live message: ${error.message}`);
          },
        }, { sessionHandle: this.sessionHandle });
      } catch (error) {
        clearTimeout(connectionTimeout);
        const message = error instanceof Error ? error.message : String(error);
        failInitialConnection(message);
        this.scheduleReconnect(message);
      }
    });
  }

  private handleProviderMessage(message: GeminiLiveMessage): void {
    const resumption = message.sessionResumptionUpdate;
    if (resumption?.resumable && resumption.newHandle) {
      this.sessionHandle = resumption.newHandle;
    }

    if (message.serverContent?.interrupted) {
      this.epoch += 1;
      this.options.onInterrupted();
      this.publish();
    }

    if (message.toolCall?.functionCalls) {
      this.handleToolCalls(message.toolCall.functionCalls);
    }

    const transcript = message.serverContent?.outputTranscription?.text?.trim();
    if (transcript) this.options.onText(transcript);

    for (const part of message.serverContent?.modelTurn?.parts ?? []) {
      if (part.text?.trim()) this.options.onText(part.text.trim());
      if (part.inlineData?.data && part.inlineData.mimeType.startsWith("audio/pcm")) {
        this.options.onAudio(part.inlineData.data, parseSampleRate(part.inlineData.mimeType));
      }
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
    this.providerClient = null;
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
    client.close();
  }

  private publish(): void {
    this.options.onSnapshot({
      connection: this.state,
      provider: this.state === "idle" ? null : "gemini_native",
      epoch: this.epoch,
      reconnectAttempts: this.reconnectAttempts,
      lastError: this.lastError,
    });
  }
}

function parseSampleRate(mimeType: string): number {
  const match = /rate=(\d+)/i.exec(mimeType);
  return match ? Number(match[1]) : 24_000;
}
