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
    inputTranscription?: { text?: string };
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
  "Answer scene questions directly from the most recent camera frame.",
  "Describe nearby obstacles first, then give one short action the user can take.",
  "Never claim that a route or walking path is clear from a single image.",
  "The phone owns route progress and arrival. Never invent a turn, route segment, clear path, or arrival.",
  "Report route, pause, resume, repeat, confirmation, and cancel requests with report_user_intent. Do not use that tool for scene questions.",
  "Wait for the phone's result before speaking as if a navigation request succeeded.",
  "Use report_scene_observation only when the phone asks for a route-anchor check.",
  "Use report_safety_observation only when the phone asks for an automatic obstacle scan.",
  "An automatic obstacle scan is silent. Call the tool once and do not speak.",
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
      {
        name: "report_safety_observation",
        description:
          "Report an obstacle in the user's likely walking path during an automatic obstacle scan.",
        parameters: {
          type: "OBJECT",
          properties: {
            hazardLevel: {
              type: "STRING",
              enum: ["clear", "caution", "danger", "unknown"],
              description:
                "Use danger for an immediate collision risk, caution for a nearby path obstacle, clear only when no obstacle is visible, and unknown when the view cannot support a judgment.",
            },
            obstacle: {
              type: "STRING",
              description: "A short concrete description of what is in front of the user.",
            },
            instruction: {
              type: "STRING",
              description: "One short action such as stop, slow down, or move left or right only when the image supports that direction.",
            },
            viewUsable: { type: "BOOLEAN" },
          },
          required: ["hazardLevel", "obstacle", "instruction", "viewUsable"],
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
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            realtimeInputConfig: {
              automaticActivityDetection: {
                disabled: false,
                prefixPaddingMs: 40,
                silenceDurationMs: 500,
              },
            },
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

  sendUserTurn(text: string): void {
    this.send({
      clientContent: {
        turns: [{ role: "user", parts: [{ text }] }],
        turnComplete: true,
      },
    });
  }

  sendContext(text: string): void {
    this.send({
      clientContent: {
        turns: [{ role: "user", parts: [{ text }] }],
        turnComplete: false,
      },
    });
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
