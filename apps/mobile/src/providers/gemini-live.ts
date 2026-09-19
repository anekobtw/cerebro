import { providerConfig } from "./config";

const liveEndpoint =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export interface GeminiLiveMessage {
  setupComplete?: Record<string, never>;
  serverContent?: {
    modelTurn?: {
      parts?: Array<{
        text?: string;
        inlineData?: { data: string; mimeType: string };
      }>;
    };
    turnComplete?: boolean;
    interrupted?: boolean;
  };
}

export interface GeminiLiveCallbacks {
  onMessage(message: GeminiLiveMessage): void;
  onOpen?(): void;
  onClose?(event: CloseEvent): void;
  onError?(event: Event): void;
}

export class GeminiLiveClient {
  #socket: WebSocket | null = null;

  connect(callbacks: GeminiLiveCallbacks): void {
    if (this.#socket !== null) {
      throw new Error("Gemini Live session is already connected");
    }

    const url = `${liveEndpoint}?key=${encodeURIComponent(providerConfig.geminiApiKey)}`;
    const socket = new WebSocket(url);
    this.#socket = socket;

    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          setup: {
            model: `models/${providerConfig.geminiLiveModel}`,
            responseModalities: ["AUDIO"],
          },
        }),
      );
      callbacks.onOpen?.();
    };

    socket.onmessage = (event) => {
      callbacks.onMessage(JSON.parse(String(event.data)) as GeminiLiveMessage);
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
    this.#socket?.close();
  }

  private send(message: object): void {
    if (this.#socket?.readyState !== WebSocket.OPEN) {
      throw new Error("Gemini Live session is not connected");
    }

    this.#socket.send(JSON.stringify(message));
  }
}
