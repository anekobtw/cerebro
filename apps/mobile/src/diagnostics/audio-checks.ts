import { encodeBase64 } from "../audio/base64";
import { MicrophoneStream, TARGET_CHUNK_MS, TARGET_SAMPLE_RATE_HZ } from "../audio/microphone";
import {
  floatToPcm16,
  generateTone,
  pcm16ToBytes,
  peakLevel,
  samplesForDurationMs,
} from "../audio/pcm";
import { PcmPlayer } from "../audio/player";
import { StreamingResampler } from "../audio/resampler";
import type { CapturedAudioChunk } from "../audio/types";
import { monotonicNowMs } from "../session/clock";

const PLAYBACK_SAMPLE_RATE_HZ = 24_000;

export type CheckStatus = "pending" | "running" | "pass" | "fail" | "check-by-ear";

export interface CheckResult {
  id: number;
  title: string;
  status: CheckStatus;
  detail: string;
}

export const CHECK_TITLES: readonly string[] = [
  "Play a locally generated test buffer",
  "Capture ten seconds of mono input and inspect the sample rate",
  "Convert float samples to PCM16 with clamping",
  "Resample to 16 kHz when the capture rate differs",
  "Deliver 100 ms chunks to a test receiver",
  "Play incoming PCM at its declared sample rate",
  "Capture and play at the same time on the speaker",
  "Stop playback, reject late chunks, start a new utterance",
];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toneSamples(frequencyHz: number, durationMs: number, sampleRateHz: number): Int16Array {
  return floatToPcm16(generateTone({ frequencyHz, durationMs, sampleRateHz }));
}

class ChunkCollector {
  readonly chunks: CapturedAudioChunk[] = [];
  readonly arrivalMs: number[] = [];

  collect = (chunk: CapturedAudioChunk): void => {
    this.chunks.push(chunk);
    this.arrivalMs.push(monotonicNowMs());
  };

  get meanIntervalMs(): number | null {
    if (this.arrivalMs.length < 2) {
      return null;
    }

    const span = this.arrivalMs[this.arrivalMs.length - 1] - this.arrivalMs[0];
    return span / (this.arrivalMs.length - 1);
  }

  peakAfter(monotonicMs: number): number {
    let peak = 0;

    for (let index = 0; index < this.chunks.length; index += 1) {
      if (this.arrivalMs[index] >= monotonicMs) {
        peak = Math.max(peak, this.chunks[index].peakLevel);
      }
    }

    return peak;
  }
}

export class AudioCheckRunner {
  constructor(private readonly player: PcmPlayer) {}

  async run(id: number): Promise<CheckResult> {
    const title = CHECK_TITLES[id - 1] ?? `Check ${id}`;

    try {
      const outcome = await this.execute(id);
      return { id, title, ...outcome };
    } catch (error) {
      return {
        id,
        title,
        status: "fail",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async execute(id: number): Promise<Pick<CheckResult, "status" | "detail">> {
    switch (id) {
      case 1:
        return this.playGeneratedBuffer();
      case 2:
        return this.inspectCaptureFormat();
      case 3:
        return this.convertWithClamping();
      case 4:
        return this.resampleToTarget();
      case 5:
        return this.deliverChunks();
      case 6:
        return this.playDeclaredRate();
      case 7:
        return this.captureWhilePlaying();
      case 8:
        return this.interruptAndRestart();
      default:
        return { status: "fail", detail: `Unknown check ${id}` };
    }
  }

  private async playGeneratedBuffer(): Promise<Pick<CheckResult, "status" | "detail">> {
    const result = this.player.playSamples({
      utteranceId: "check-1",
      epoch: this.player.epoch,
      sampleRateHz: PLAYBACK_SAMPLE_RATE_HZ,
      samples: toneSamples(440, 700, PLAYBACK_SAMPLE_RATE_HZ),
    });

    await delay(900);
    const stats = this.player.getStats();

    if (result !== "queued" || stats.lastError !== null) {
      return {
        status: "fail",
        detail: `Enqueue returned ${result}. ${stats.lastError ?? "No error reported."}`,
      };
    }

    return {
      status: "check-by-ear",
      detail: `Queued ${stats.chunksQueued} buffers, output context ${stats.contextSampleRateHz ?? "unknown"} Hz. A 440 Hz tone should have played for 0.7 s.`,
    };
  }

  private async inspectCaptureFormat(): Promise<Pick<CheckResult, "status" | "detail">> {
    const collector = new ChunkCollector();
    const mic = new MicrophoneStream({ onChunk: collector.collect });

    await mic.start();
    const started = mic.getStats();

    if (started.lastError !== null) {
      return { status: "fail", detail: started.lastError };
    }

    await delay(10_000);
    const stats = mic.getStats();
    await mic.stop();

    if (stats.observedSampleRateHz === null) {
      return { status: "fail", detail: "No audio buffers arrived in ten seconds." };
    }

    return {
      status: stats.observedChannels === 1 ? "pass" : "check-by-ear",
      detail: `Device delivered ${stats.observedSampleRateHz} Hz, ${stats.observedChannels} channel(s), ${stats.observedFramesPerCallback} frames per callback against a request for ${stats.requestedSampleRateHz} Hz mono. Resampling ${stats.resampled ? "on" : "off"}. ${collector.chunks.length} chunks in ten seconds.`,
    };
  }

  private convertWithClamping(): Pick<CheckResult, "status" | "detail"> {
    const input = Float32Array.from([0, 1, -1, 1.5, -1.5, 0.5, -0.5]);
    const pcm = floatToPcm16(input);
    const expected = [0, 32767, -32768, 32767, -32768, 16384, -16384];
    const actual = Array.from(pcm);
    const matches = actual.every((value, index) => value === expected[index]);
    const bytes = pcm16ToBytes(Int16Array.from([1, -32768]));
    const littleEndian = bytes[0] === 0x01 && bytes[1] === 0x00 && bytes[2] === 0x00 && bytes[3] === 0x80;
    const base64 = encodeBase64(pcm16ToBytes(pcm));

    return {
      status: matches && littleEndian ? "pass" : "fail",
      detail: `PCM16 output ${actual.join(", ")}. Little-endian byte order ${littleEndian ? "confirmed" : "wrong"}. Base64 prefix ${base64.slice(0, 12)}.`,
    };
  }

  private resampleToTarget(): Pick<CheckResult, "status" | "detail"> {
    const sourceRateHz = 48_000;
    const input = generateTone({
      frequencyHz: 300,
      durationMs: 500,
      sampleRateHz: sourceRateHz,
      amplitude: 1,
    });
    const output = new StreamingResampler(sourceRateHz, TARGET_SAMPLE_RATE_HZ).process(input);
    const reference = generateTone({
      frequencyHz: 300,
      durationMs: 500,
      sampleRateHz: TARGET_SAMPLE_RATE_HZ,
      amplitude: 1,
    });

    let worstError = 0;
    for (let index = 200; index < output.length - 200; index += 1) {
      worstError = Math.max(worstError, Math.abs(output[index] - reference[index]));
    }

    const aliasProbe = new StreamingResampler(sourceRateHz, TARGET_SAMPLE_RATE_HZ).process(
      generateTone({ frequencyHz: 11_000, durationMs: 500, sampleRateHz: sourceRateHz, amplitude: 1 }),
    );
    const aliasPeak = peakLevel(aliasProbe.subarray(400));

    return {
      status: worstError < 0.05 && aliasPeak < 0.2 ? "pass" : "fail",
      detail: `48 kHz to 16 kHz: ${input.length} samples in, ${output.length} out. Worst error against a reference 300 Hz tone ${worstError.toFixed(4)}. An 11 kHz tone came back at peak ${aliasPeak.toFixed(3)} rather than aliasing into the speech band.`,
    };
  }

  private async deliverChunks(): Promise<Pick<CheckResult, "status" | "detail">> {
    const collector = new ChunkCollector();
    const mic = new MicrophoneStream({ onChunk: collector.collect });

    await mic.start();
    const started = mic.getStats();

    if (started.lastError !== null) {
      return { status: "fail", detail: started.lastError };
    }

    await delay(3_000);
    await mic.stop();

    const expectedBytes = samplesForDurationMs(TARGET_SAMPLE_RATE_HZ, TARGET_CHUNK_MS) * 2;
    const first = collector.chunks[0];
    const bytes = first === undefined ? 0 : Math.round((first.pcmBase64.length / 4) * 3);
    const meanInterval = collector.meanIntervalMs;
    const uniformDuration = collector.chunks.every((chunk) => chunk.durationMs === TARGET_CHUNK_MS);
    const enoughChunks = collector.chunks.length >= 25 && collector.chunks.length <= 35;

    return {
      status: enoughChunks && uniformDuration && bytes === expectedBytes ? "pass" : "fail",
      detail: `${collector.chunks.length} chunks in 3 s, each ${TARGET_CHUNK_MS} ms and ${bytes} bytes against an expected ${expectedBytes}. Mean arrival gap ${meanInterval === null ? "not measurable" : `${meanInterval.toFixed(1)} ms`}.`,
    };
  }

  private async playDeclaredRate(): Promise<Pick<CheckResult, "status" | "detail">> {
    this.player.playSamples({
      utteranceId: "check-6-24k",
      epoch: this.player.epoch,
      sampleRateHz: PLAYBACK_SAMPLE_RATE_HZ,
      samples: toneSamples(440, 800, PLAYBACK_SAMPLE_RATE_HZ),
    });
    await delay(1_100);

    this.player.playSamples({
      utteranceId: "check-6-16k",
      epoch: this.player.epoch,
      sampleRateHz: TARGET_SAMPLE_RATE_HZ,
      samples: toneSamples(440, 800, TARGET_SAMPLE_RATE_HZ),
    });
    await delay(1_100);

    const stats = this.player.getStats();

    return {
      status: "check-by-ear",
      detail: `Two 440 Hz tones of 0.8 s, declared at 24 kHz then 16 kHz. Output context ${stats.contextSampleRateHz ?? "unknown"} Hz, resampling ${stats.resamplingForOutput ? "on" : "off"}. Both must sound the same pitch and length. A higher or shorter second tone means the declared rate was ignored.`,
    };
  }

  private async captureWhilePlaying(): Promise<Pick<CheckResult, "status" | "detail">> {
    const collector = new ChunkCollector();
    const mic = new MicrophoneStream({ onChunk: collector.collect });

    await mic.start();
    const started = mic.getStats();

    if (started.lastError !== null) {
      return { status: "fail", detail: started.lastError };
    }

    await delay(1_500);
    const roomPeak = collector.peakAfter(0);
    const playbackStartedAtMs = monotonicNowMs();

    this.player.playSamples({
      utteranceId: "check-7",
      epoch: this.player.epoch,
      sampleRateHz: PLAYBACK_SAMPLE_RATE_HZ,
      samples: toneSamples(660, 2_500, PLAYBACK_SAMPLE_RATE_HZ),
    });

    await delay(2_800);
    const playbackPeak = collector.peakAfter(playbackStartedAtMs + 200);
    await mic.stop();

    const ratio = roomPeak === 0 ? Number.POSITIVE_INFINITY : playbackPeak / roomPeak;
    const echoHeard = playbackPeak > 0.05 && ratio > 3;
    const verdict = echoHeard
      ? "The speaker is reaching the microphone, so the assistant will interrupt itself. Android echo cancellation is not active; see docs/MOBILE_MEDIA_CHECKS.md."
      : "No strong speaker leakage at this volume. Repeat at demo volume, outdoors, and while speaking over the tone.";

    return {
      status: echoHeard ? "fail" : "pass",
      detail: `Room peak before playback ${roomPeak.toFixed(3)}, microphone peak during playback ${playbackPeak.toFixed(3)}, ratio ${ratio.toFixed(1)}. ${verdict}`,
    };
  }

  private async interruptAndRestart(): Promise<Pick<CheckResult, "status" | "detail">> {
    const firstEpoch = this.player.epoch;

    this.player.playSamples({
      utteranceId: "check-8-first",
      epoch: firstEpoch,
      sampleRateHz: PLAYBACK_SAMPLE_RATE_HZ,
      samples: toneSamples(330, 2_500, PLAYBACK_SAMPLE_RATE_HZ),
    });

    await delay(500);
    const nextEpoch = this.player.interrupt();

    const lateChunk = this.player.enqueue({
      utteranceId: "check-8-first",
      epoch: firstEpoch,
      sampleRateHz: PLAYBACK_SAMPLE_RATE_HZ,
      samples: toneSamples(330, 200, PLAYBACK_SAMPLE_RATE_HZ),
    });

    const restarted = this.player.playSamples({
      utteranceId: "check-8-second",
      epoch: nextEpoch,
      sampleRateHz: PLAYBACK_SAMPLE_RATE_HZ,
      samples: toneSamples(880, 600, PLAYBACK_SAMPLE_RATE_HZ),
    });

    await delay(900);
    const stats = this.player.getStats();

    return {
      status: lateChunk === "stale-epoch" && restarted === "queued" ? "pass" : "fail",
      detail: `Epoch ${firstEpoch} interrupted after 0.5 s, new epoch ${nextEpoch}. The late chunk was ${lateChunk} and the new utterance was ${restarted}. Rejected totals ${JSON.stringify(stats.chunksRejected)}. The low tone must stop the moment the high tone starts.`,
    };
  }
}
