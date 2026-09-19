import { AudioBufferQueueSourceNode, AudioContext } from "react-native-audio-api";

import { pcm16ToFloat, type FloatSamples } from "./pcm";
import { StreamingResampler } from "./resampler";
import type { EnqueueResult, PlayableChunk } from "./types";

export const MAX_QUEUED_MS = 2_000;

export interface PlayerStats {
  contextSampleRateHz: number | null;
  declaredSampleRateHz: number | null;
  resamplingForOutput: boolean;
  activeUtteranceId: string | null;
  activeEpoch: number;
  queuedMs: number;
  chunksQueued: number;
  chunksRejected: Record<Exclude<EnqueueResult, "queued">, number>;
  lastError: string | null;
}

export interface PcmPlayerOptions {
  onStats?: (stats: PlayerStats) => void;
  maxQueuedMs?: number;
}

/**
 * Plays PCM16 utterances through one queue node per utterance. Cancellation stops
 * the node and builds a new queue for the next utterance; chunks tagged with an
 * older epoch or utterance are dropped instead of being played late.
 */
export class PcmPlayer {
  private context: AudioContext | null = null;
  private queue: AudioBufferQueueSourceNode | null = null;
  private resampler: StreamingResampler | null = null;
  private activeUtteranceId: string | null = null;
  private activeEpoch = 0;
  private playbackEndsAtContextTime = 0;
  private declaredSampleRateHz: number | null = null;
  private readonly maxQueuedMs: number;
  private readonly rejected: Record<Exclude<EnqueueResult, "queued">, number> = {
    "stale-epoch": 0,
    "stale-utterance": 0,
    "queue-full": 0,
    stopped: 0,
  };
  private chunksQueued = 0;
  private lastError: string | null = null;

  constructor(private readonly options: PcmPlayerOptions = {}) {
    this.maxQueuedMs = options.maxQueuedMs ?? MAX_QUEUED_MS;
  }

  get epoch(): number {
    return this.activeEpoch;
  }

  get isSpeaking(): boolean {
    return this.queuedMs > 0;
  }

  get queuedMs(): number {
    if (this.context === null) {
      return 0;
    }

    return Math.max(0, (this.playbackEndsAtContextTime - this.context.currentTime) * 1000);
  }

  getStats(): PlayerStats {
    return {
      contextSampleRateHz: this.context?.sampleRate ?? null,
      declaredSampleRateHz: this.declaredSampleRateHz,
      resamplingForOutput: this.resampler !== null && !this.resampler.isPassthrough,
      activeUtteranceId: this.activeUtteranceId,
      activeEpoch: this.activeEpoch,
      queuedMs: Math.round(this.queuedMs),
      chunksQueued: this.chunksQueued,
      chunksRejected: { ...this.rejected },
      lastError: this.lastError,
    };
  }

  beginUtterance(utteranceId: string, epoch: number): void {
    if (epoch < this.activeEpoch) {
      this.reject("stale-epoch");
      return;
    }

    this.activeEpoch = epoch;
    this.activeUtteranceId = utteranceId;
    this.publish();
  }

  enqueue(chunk: PlayableChunk): EnqueueResult {
    if (chunk.epoch < this.activeEpoch) {
      return this.reject("stale-epoch");
    }

    if (this.activeUtteranceId !== null && chunk.utteranceId !== this.activeUtteranceId) {
      return this.reject("stale-utterance");
    }

    if (this.queuedMs > this.maxQueuedMs) {
      return this.reject("queue-full");
    }

    try {
      const context = this.ensureContext(chunk.sampleRateHz);
      const queue = this.ensureQueue(context);
      const samples = this.toContextRate(context, chunk);
      const buffer = context.createBuffer(1, samples.length, context.sampleRate);

      buffer.copyToChannel(samples, 0);
      queue.enqueueBuffer(buffer);

      const durationSeconds = samples.length / context.sampleRate;
      this.playbackEndsAtContextTime =
        Math.max(this.playbackEndsAtContextTime, context.currentTime) + durationSeconds;
      this.chunksQueued += 1;
      this.lastError = null;
      this.publish();

      return "queued";
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.publish();
      return "stopped";
    }
  }

  playSamples(options: {
    utteranceId: string;
    epoch: number;
    sampleRateHz: number;
    samples: Int16Array;
    chunkSamples?: number;
  }): EnqueueResult {
    const { utteranceId, epoch, sampleRateHz, samples, chunkSamples = sampleRateHz / 10 } = options;

    this.beginUtterance(utteranceId, epoch);

    let result: EnqueueResult = "queued";

    for (let offset = 0; offset < samples.length; offset += chunkSamples) {
      result = this.enqueue({
        utteranceId,
        epoch,
        sampleRateHz,
        samples: samples.slice(offset, offset + chunkSamples),
      });

      if (result !== "queued") {
        break;
      }
    }

    return result;
  }

  /** Cancels the current utterance and raises the epoch so late chunks are dropped. */
  interrupt(): number {
    this.activeEpoch += 1;
    this.stop();
    return this.activeEpoch;
  }

  stop(): void {
    if (this.queue !== null) {
      try {
        this.queue.stop();
        this.queue.disconnect();
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
      this.queue = null;
    }

    this.activeUtteranceId = null;
    this.playbackEndsAtContextTime = this.context?.currentTime ?? 0;
    this.publish();
  }

  async close(): Promise<void> {
    this.stop();
    const context = this.context;
    this.context = null;
    this.resampler = null;
    this.declaredSampleRateHz = null;
    await context?.close();
    this.publish();
  }

  private ensureContext(sampleRateHz: number): AudioContext {
    if (this.context === null) {
      this.context = new AudioContext({ sampleRate: sampleRateHz });
      this.declaredSampleRateHz = sampleRateHz;
      this.playbackEndsAtContextTime = this.context.currentTime;
    }

    return this.context;
  }

  private ensureQueue(context: AudioContext): AudioBufferQueueSourceNode {
    if (this.queue === null) {
      const queue = context.createBufferQueueSource();
      queue.connect(context.destination);
      queue.start();
      this.queue = queue;
    }

    return this.queue;
  }

  private toContextRate(context: AudioContext, chunk: PlayableChunk): FloatSamples {
    const floats = pcm16ToFloat(chunk.samples);

    if (chunk.sampleRateHz === context.sampleRate) {
      this.resampler = null;
      return floats;
    }

    if (this.resampler === null || this.resampler.inputRateHz !== chunk.sampleRateHz) {
      this.resampler = new StreamingResampler(chunk.sampleRateHz, context.sampleRate);
    }

    return this.resampler.process(floats);
  }

  private reject(reason: Exclude<EnqueueResult, "queued">): EnqueueResult {
    this.rejected[reason] += 1;
    this.publish();
    return reason;
  }

  private publish(): void {
    this.options.onStats?.(this.getStats());
  }
}
