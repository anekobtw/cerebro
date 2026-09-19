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

const phaseTwoSystemInstruction = [
  "You are the voice and scene-description assistant for a Blind Maps development check.",
  "This build has no surveyed route loaded, so never give walking, turning, street-crossing, or arrival instructions.",
  "Describe only visible evidence. Say when the camera view is unusable or uncertain.",
  "Keep spoken answers short.",
].join(" ");

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
              parts: [{ text: phaseTwoSystemInstruction }],
            },
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
