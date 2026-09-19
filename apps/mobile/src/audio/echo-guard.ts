import type { CapturedAudioChunk } from "./types";
import { encodeBase64, decodeBase64 } from "./base64";

const ECHO_TAIL_MS = 400;

/** Suppresses speaker feedback on builds without native echo cancellation. */
export class EchoGuard {
  private quietUntilMs = 0;
  private localSpeech = false;

  setLocalSpeech(speaking: boolean, nowMs: number): void {
    this.localSpeech = speaking;
    this.quietUntilMs = nowMs + ECHO_TAIL_MS;
  }

  filter(chunk: CapturedAudioChunk, queuedMs: number, nowMs: number): CapturedAudioChunk {
    if (queuedMs > 0 || this.localSpeech) {
      this.quietUntilMs = nowMs + ECHO_TAIL_MS + chunk.durationMs;
    }
    if (nowMs >= this.quietUntilMs) return chunk;

    // Keep the input clock running so provider VAD can finish the user's turn.
    return {
      ...chunk,
      pcmBase64: encodeBase64(new Uint8Array(decodeBase64(chunk.pcmBase64).length)),
      peakLevel: 0,
    };
  }
}
