import { AudioManager, AudioRecorder } from "react-native-audio-api";

import { monotonicNowMs } from "../session/clock";
import { PcmChunker } from "./chunker";
import {
  downmixToMono,
  durationMsForSamples,
  floatToPcm16,
  pcm16ToBytes,
  peakLevel,
  samplesForDurationMs,
  type FloatSamples,
} from "./pcm";
import { encodeBase64 } from "./base64";
import { StreamingResampler } from "./resampler";
import type { CapturedAudioChunk } from "./types";

export const TARGET_SAMPLE_RATE_HZ = 16_000;
export const TARGET_CHUNK_MS = 100;

export interface MicrophoneStats {
  running: boolean;
  starting: boolean;
  muted: boolean;
  requestedSampleRateHz: number;
  observedSampleRateHz: number | null;
  observedChannels: number | null;
  observedFramesPerCallback: number | null;
  resampled: boolean;
  chunksEmitted: number;
  chunksSuppressedWhileMuted: number;
  lastChunkBytes: number;
  lastPeakLevel: number;
  lastError: string | null;
}

export interface MicrophoneOptions {
  onChunk: (chunk: CapturedAudioChunk) => void;
  onStats?: (stats: MicrophoneStats) => void;
  onError?: (message: string) => void;
  targetSampleRateHz?: number;
  chunkMs?: number;
}

export class MicrophoneStream {
  private readonly recorder = new AudioRecorder();
  private readonly targetSampleRateHz: number;
  private readonly chunkMs: number;
  private chunker: PcmChunker;
  private resampler: StreamingResampler | null = null;
  private chunkIndex = 0;
  private muted = false;
  private running = false;
  private starting = false;
  private startInFlight = false;
  private runId = 0;
  private stats: MicrophoneStats;

  constructor(private readonly options: MicrophoneOptions) {
    this.targetSampleRateHz = options.targetSampleRateHz ?? TARGET_SAMPLE_RATE_HZ;
    this.chunkMs = options.chunkMs ?? TARGET_CHUNK_MS;
    this.chunker = new PcmChunker(samplesForDurationMs(this.targetSampleRateHz, this.chunkMs));
    this.stats = {
      running: false,
      starting: false,
      muted: false,
      requestedSampleRateHz: this.targetSampleRateHz,
      observedSampleRateHz: null,
      observedChannels: null,
      observedFramesPerCallback: null,
      resampled: false,
      chunksEmitted: 0,
      chunksSuppressedWhileMuted: 0,
      lastChunkBytes: 0,
      lastPeakLevel: 0,
      lastError: null,
    };
  }

  getStats(): MicrophoneStats {
    return { ...this.stats };
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.publish({ muted });
  }

  async start(): Promise<void> {
    if (this.running || this.startInFlight) {
      return;
    }

    this.runId += 1;
    const currentRunId = this.runId;
    this.starting = true;
    this.startInFlight = true;
    this.publish({ starting: true, lastError: null });

    let permission: Awaited<ReturnType<typeof AudioManager.requestRecordingPermissions>>;

    try {
      permission = await AudioManager.requestRecordingPermissions();
    } catch (error) {
      this.starting = false;
      this.startInFlight = false;
      this.publish({ starting: false });
      this.fail(error instanceof Error ? error.message : String(error));
      return;
    }

    if (currentRunId !== this.runId) {
      this.startInFlight = false;
      return;
    }

    if (permission !== "Granted") {
      this.starting = false;
      this.startInFlight = false;
      this.publish({ starting: false });
      this.fail(`Microphone permission ${permission}`);
      return;
    }

    this.recorder.onError((error) => {
      if (currentRunId === this.runId) {
        this.fail(error.message);
      }
    });

    const subscription = this.recorder.onAudioReady(
      {
        sampleRate: this.targetSampleRateHz,
        bufferLength: samplesForDurationMs(this.targetSampleRateHz, this.chunkMs),
        channelCount: 1,
      },
      (event) => {
        if (currentRunId === this.runId) {
          this.handleBuffer(event.buffer, event.numFrames);
        }
      },
    );

    if (subscription.status === "error") {
      this.starting = false;
      this.startInFlight = false;
      this.recorder.clearOnError();
      this.publish({ starting: false });
      this.fail(subscription.message);
      return;
    }

    const started = await this.recorder.start();

    if (currentRunId !== this.runId) {
      if (started.status !== "error") {
        await this.recorder.stop();
      }
      this.recorder.clearOnAudioReady();
      this.recorder.clearOnError();
      this.startInFlight = false;
      return;
    }

    if (started.status === "error") {
      this.starting = false;
      this.startInFlight = false;
      this.recorder.clearOnAudioReady();
      this.recorder.clearOnError();
      this.publish({ starting: false });
      this.fail(started.message);
      return;
    }

    this.starting = false;
    this.startInFlight = false;
    this.running = true;
    this.publish({ running: true, starting: false, lastError: null });
  }

  async stop(): Promise<void> {
    this.runId += 1;
    this.running = false;
    this.starting = false;
    if (this.recorder.isRecording()) {
      await this.recorder.stop();
    }
    this.recorder.clearOnAudioReady();
    this.recorder.clearOnError();
    this.chunker.reset();
    this.resampler?.reset();
    this.publish({ running: false, starting: false });
  }

  private handleBuffer(buffer: AudioBufferInput, numFrames: number): void {
    const channels: FloatSamples[] = [];

    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      channels.push(buffer.getChannelData(channel).subarray(0, numFrames));
    }

    const mono = downmixToMono(channels);
    const sourceRateHz = buffer.sampleRate;

    if (this.resampler === null || this.resampler.inputRateHz !== sourceRateHz) {
      this.resampler = new StreamingResampler(sourceRateHz, this.targetSampleRateHz);
      this.chunker.reset();
    }

    const resampled = this.resampler.process(mono);
    const level = peakLevel(resampled);

    this.publish({
      observedSampleRateHz: sourceRateHz,
      observedChannels: buffer.numberOfChannels,
      observedFramesPerCallback: numFrames,
      resampled: !this.resampler.isPassthrough,
      lastPeakLevel: level,
    });

    for (const chunk of this.chunker.push(floatToPcm16(resampled))) {
      if (this.muted) {
        this.stats.chunksSuppressedWhileMuted += 1;
        continue;
      }

      const bytes = pcm16ToBytes(chunk);

      this.chunkIndex += 1;
      this.stats.chunksEmitted += 1;
      this.stats.lastChunkBytes = bytes.length;

      this.options.onChunk({
        codec: "pcm_s16le",
        sampleRateHz: this.targetSampleRateHz,
        channels: 1,
        chunkIndex: this.chunkIndex,
        pcmBase64: encodeBase64(bytes),
        capturedAtMonotonicMs: monotonicNowMs(),
        durationMs: durationMsForSamples(chunk.length, this.targetSampleRateHz),
        peakLevel: level,
      });
    }

    this.options.onStats?.(this.getStats());
  }

  private fail(message: string): void {
    this.publish({ lastError: message, running: this.running });
    this.options.onError?.(message);
  }

  private publish(patch: Partial<MicrophoneStats>): void {
    this.stats = { ...this.stats, ...patch, muted: patch.muted ?? this.muted };
    this.options.onStats?.(this.getStats());
  }
}

interface AudioBufferInput {
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  getChannelData(channel: number): FloatSamples;
}
