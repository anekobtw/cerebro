import { providerConfig } from "./config";
import { decodeSocketFrame } from "./socket-frame";

const liveEndpoint =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export interface GeminiLiveMessage {
  setupComplete?: Record<string, never>;
  goAway?: { timeLeft?: string };
  sessionResumptionUpdate?: {
    newHandle?: string;
    resumable?: boolean;
  };
  serverContent?: {
    modelTurn?: {
      parts?: Array<{
        text?: string;
        inlineData?: { data: string; mimeType: string };
      }>;
    };
    turnComplete?: boolean;
    interrupted?: boolean;
    outputTranscription?: { text?: string };
  };
  toolCall?: {
    functionCalls?: Array<{
      id?: string;
      name?: string;
      args?: unknown;
    }>;
  };
}

export interface GeminiLiveCallbacks {
  onMessage(message: GeminiLiveMessage): void;
  onOpen?(): void;
  onReady?(): void;
  onClose?(event: CloseEvent): void;
  onError?(event: Event): void;
  onProtocolError?(error: Error): void;
}

export interface GeminiLiveConnectOptions {
  sessionHandle?: string | null;
}

const systemInstruction = [
  "You are the voice and scene assistant for Blind Maps.",
  "The phone owns route progress and arrival. Never invent a turn, route segment, clear path, or arrival.",
  "Report navigation requests with report_user_intent. Wait for the phone's result before speaking as if the request succeeded.",
  "Use report_scene_observation only when the phone asks for a route-anchor check.",
  "Candidate anchors must come from the allowlist in that request.",
  "Describe only visible evidence. If the view is poor, set viewUsable false and requiresAnotherView true.",
  "A door's image position does not establish a safe turn direction.",
  "Keep spoken answers short.",
].join(" ");

const navigationTools = [
  {
    functionDeclarations: [
      {
        name: "report_user_intent",
        description:
          "Report a navigation request after the user clearly asks for it or confirms it.",
        parameters: {
          type: "OBJECT",
          properties: {
            kind: {
              type: "STRING",
              enum: [
                "request_destination",
                "confirm_destination",
                "pause",
                "resume",
                "repeat",
                "describe_scene",
                "confirm_vestibule",
                "cancel",
              ],
            },
            destinationId: {
              type: "STRING",
              description: "Use usf-tampa-library for the supported library destination.",
            },
          },
          required: ["kind"],
        },
      },
      {
        name: "report_scene_observation",
        description:
          "Return visible evidence for the active scene-check request. Use only allowed anchor ids.",
        parameters: {
          type: "OBJECT",
          properties: {
            visibleText: { type: "ARRAY", items: { type: "STRING" } },
            candidateAnchorIds: { type: "ARRAY", items: { type: "STRING" } },
            doorPositionInImage: {
              type: "STRING",
              enum: ["left", "center", "right", "unknown"],
            },
            viewUsable: { type: "BOOLEAN" },
            requiresAnotherView: { type: "BOOLEAN" },
            description: { type: "STRING" },
          },
          required: [
            "visibleText",
            "candidateAnchorIds",
            "doorPositionInImage",
            "viewUsable",
            "requiresAnotherView",
            "description",
          ],
        },
      },
    ],
  },
];

export class GeminiLiveClient {
  #socket: WebSocket | null = null;

  get bufferedAmountBytes(): number {
    return this.#socket?.bufferedAmount ?? 0;
  }

  connect(callbacks: GeminiLiveCallbacks, options: GeminiLiveConnectOptions = {}): void {
    if (this.#socket !== null) {
      throw new Error("Gemini Live session is already connected");
    }

    const url = `${liveEndpoint}?key=${encodeURIComponent(providerConfig.geminiApiKey)}`;
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    this.#socket = socket;

    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          setup: {
            model: `models/${providerConfig.geminiLiveModel}`,
            generationConfig: {
              responseModalities: ["AUDIO"],
            },
            systemInstruction: {
              parts: [{ text: systemInstruction }],
            },
            tools: navigationTools,
            outputAudioTranscription: {},
            contextWindowCompression: { slidingWindow: {} },
            sessionResumption: options.sessionHandle
              ? { handle: options.sessionHandle }
              : {},
          },
        }),
      );
      callbacks.onOpen?.();
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(decodeSocketFrame(event.data)) as GeminiLiveMessage;
        if (message.setupComplete) callbacks.onReady?.();
        callbacks.onMessage(message);
      } catch (error) {
        callbacks.onProtocolError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
        this.close();
      }
    };
    socket.onerror = (event) => callbacks.onError?.(event);
    socket.onclose = (event) => {
      this.#socket = null;
      callbacks.onClose?.(event);
    };
  }

  sendText(text: string): void {
    this.send({ realtimeInput: { text } });
  }

  sendPcmAudio(pcmBase64: string): void {
    this.send({
      realtimeInput: {
        audio: {
          data: pcmBase64,
          mimeType: "audio/pcm;rate=16000",
        },
      },
    });
  }

  endAudioStream(): void {
    this.send({ realtimeInput: { audioStreamEnd: true } });
  }

  sendJpegFrame(jpegBase64: string): void {
    this.send({
      realtimeInput: {
        video: {
          data: jpegBase64,
          mimeType: "image/jpeg",
        },
      },
    });
  }

  sendToolResponses(
    functionResponses: Array<{
      id?: string;
      name: string;
      response: Record<string, unknown>;
    }>,
  ): void {
    this.send({ toolResponse: { functionResponses } });
  }

  close(): void {
    const socket = this.#socket;
    this.#socket = null;
    socket?.close();
  }

  private send(message: object): void {
    if (this.#socket?.readyState !== WebSocket.OPEN) {
      throw new Error("Gemini Live session is not connected");
    }

    this.#socket.send(JSON.stringify(message));
  }
}
