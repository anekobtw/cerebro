import { providerConfig } from "./config";
import { decodeSocketFrame } from "./socket-frame";

export interface ScribeCallbacks {
  onReady(): void;
  onTranscript(text: string): void;
  onError(message: string): void;
  onClose(): void;
}

/** Streams mono PCM16 to Scribe. Only committed transcripts become user turns. */
export class ElevenLabsRealtimeClient {
  private socket: WebSocket | null = null;

  get bufferedAmountBytes(): number {
    return this.socket?.bufferedAmount ?? 0;
  }

  connect(callbacks: ScribeCallbacks): void {
    if (this.socket !== null) throw new Error("ElevenLabs STT is already connected");
    const query = new URLSearchParams({
      model_id: providerConfig.elevenLabsRealtimeSttModelId,
      audio_format: "pcm_16000",
      commit_strategy: "vad",
      vad_silence_threshold_secs: "0.8",
      language_code: "en",
      include_timestamps: "false",
    });
    // React Native supports headers in the third WebSocket argument.
    const NativeWebSocket = WebSocket as unknown as {
      new (url: string, protocols: undefined, options: { headers: Record<string, string> }): WebSocket;
    };
    const socket = new NativeWebSocket(
      `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${query}`,
      undefined,
      { headers: { "xi-api-key": providerConfig.elevenLabsApiKey } },
    );
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      try {
        const message = JSON.parse(decodeSocketFrame(event.data));
        if (message.message_type === "session_started") callbacks.onReady();
        else if (message.message_type === "committed_transcript") {
          if (typeof message.text === "string" && message.text.trim()) {
            callbacks.onTranscript(message.text.trim());
          }
        } else if (message.message_type !== "partial_transcript" &&
          message.message_type !== "committed_transcript_with_timestamps") {
          callbacks.onError(`ElevenLabs STT: ${message.error ?? message.message_type ?? "Unexpected response"}`);
        }
      } catch {
        callbacks.onError("ElevenLabs STT returned an invalid message");
      }
    };
    socket.onerror = () => {
      if (this.socket === socket) callbacks.onError("ElevenLabs STT connection failed");
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      callbacks.onClose();
    };
  }

  sendAudio(pcmBase64: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error("ElevenLabs STT is not connected");
    }
    this.socket.send(JSON.stringify({
      message_type: "input_audio_chunk",
      audio_base_64: pcmBase64,
      sample_rate: 16_000,
      commit: false,
    }));
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }
}
