import { streamSpeech, type SynthesizedSpeech } from "../providers/elevenlabs-tts";

/** Serializes synthesis and discards requests cancelled by pause, stop or a new turn. */
export class SpeechOutput {
  private generation = 0;
  private pending: Promise<void> = Promise.resolve();
  private abort: AbortController | null = null;

  constructor(private readonly options: {
    onAudio(speech: SynthesizedSpeech, generation: number): void;
    onError(message: string): void;
    onActivity?(speaking: boolean): void;
  }) {}

  speak(text: string): Promise<void> {
    const generation = this.generation;
    this.pending = this.pending.then(async () => {
      if (generation !== this.generation || !text.trim()) return;
      const abort = new AbortController();
      this.abort = abort;
      let timeout = setTimeout(() => abort.abort(), 15_000);
      try {
        await streamSpeech(text, (chunk) => {
          if (generation !== this.generation || abort.signal.aborted) return;
          clearTimeout(timeout);
          timeout = setTimeout(() => abort.abort(), 15_000);
          this.options.onActivity?.(true);
          this.options.onAudio(chunk, generation);
        }, abort.signal);
      } catch (error) {
        if (generation === this.generation) {
          this.options.onError(abort.signal.aborted
            ? "ElevenLabs TTS timed out"
            : error instanceof Error ? error.message : String(error));
        }
      } finally {
        clearTimeout(timeout);
        if (generation === this.generation) this.options.onActivity?.(false);
        if (this.abort === abort) this.abort = null;
      }
    });
    return this.pending;
  }

  cancel(): void {
    this.generation += 1;
    this.abort?.abort();
    this.abort = null;
    this.pending = Promise.resolve();
    this.options.onActivity?.(false);
  }
}
