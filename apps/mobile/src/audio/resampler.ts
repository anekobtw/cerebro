import type { FloatSamples } from "./pcm";

const HALF_WIDTH = 16;
const TAPS = HALF_WIDTH * 2;
const PHASE_COUNT = 512;
const EMPTY: FloatSamples = new Float32Array(0);

function sinc(x: number): number {
  if (x === 0) {
    return 1;
  }

  const scaled = Math.PI * x;
  return Math.sin(scaled) / scaled;
}

function buildKernel(cutoff: number): Float32Array {
  const kernel = new Float32Array(PHASE_COUNT * TAPS);

  for (let phase = 0; phase < PHASE_COUNT; phase += 1) {
    const fraction = (phase + 0.5) / PHASE_COUNT;
    const offset = phase * TAPS;
    let sum = 0;

    for (let tap = 0; tap < TAPS; tap += 1) {
      const distance = tap - HALF_WIDTH + 1 - fraction;
      const window = 0.5 * (1 + Math.cos((Math.PI * distance) / HALF_WIDTH));
      const weight = Math.abs(distance) >= HALF_WIDTH ? 0 : window * cutoff * sinc(cutoff * distance);
      kernel[offset + tap] = weight;
      sum += weight;
    }

    if (sum !== 0) {
      for (let tap = 0; tap < TAPS; tap += 1) {
        kernel[offset + tap] /= sum;
      }
    }
  }

  return kernel;
}

/**
 * Band-limited resampler that keeps filter state across chunks, so a continuous
 * microphone stream cut into 100 ms pieces produces the same samples as one pass.
 */
export class StreamingResampler {
  private readonly step: number;
  private readonly kernel: Float32Array | null;
  private pending: FloatSamples = EMPTY;
  private pendingStart = 0;
  private outputIndex = 0;

  constructor(
    readonly inputRateHz: number,
    readonly outputRateHz: number,
  ) {
    if (inputRateHz <= 0 || outputRateHz <= 0) {
      throw new Error("Sample rates must be positive");
    }

    this.step = inputRateHz / outputRateHz;
    this.kernel = inputRateHz === outputRateHz ? null : buildKernel(Math.min(1, outputRateHz / inputRateHz));
  }

  get isPassthrough(): boolean {
    return this.kernel === null;
  }

  reset(): void {
    this.pending = EMPTY;
    this.pendingStart = 0;
    this.outputIndex = 0;
  }

  process(input: FloatSamples): FloatSamples {
    const kernel = this.kernel;

    if (kernel === null) {
      return input;
    }

    if (this.pending.length === 0) {
      this.pending = input.slice();
    } else {
      const merged = new Float32Array(this.pending.length + input.length);
      merged.set(this.pending, 0);
      merged.set(input, this.pending.length);
      this.pending = merged;
    }

    const lastAvailable = this.pendingStart + this.pending.length - 1;
    const capacity = Math.ceil(this.pending.length / this.step) + 1;
    const output = new Float32Array(capacity);
    let produced = 0;

    while (produced < capacity) {
      const center = this.outputIndex * this.step;
      const floorCenter = Math.floor(center);
      const firstInput = floorCenter - HALF_WIDTH + 1;

      if (firstInput + TAPS - 1 > lastAvailable) {
        break;
      }

      const phase = Math.min(PHASE_COUNT - 1, Math.floor((center - floorCenter) * PHASE_COUNT));
      const kernelOffset = phase * TAPS;
      let value = 0;

      for (let tap = 0; tap < TAPS; tap += 1) {
        const inputIndex = firstInput + tap - this.pendingStart;
        if (inputIndex < 0 || inputIndex >= this.pending.length) {
          continue;
        }
        value += this.pending[inputIndex] * kernel[kernelOffset + tap];
      }

      output[produced] = value;
      produced += 1;
      this.outputIndex += 1;
    }

    const nextFirstInput = Math.floor(this.outputIndex * this.step) - HALF_WIDTH + 1;
    const dropCount = Math.max(0, Math.min(this.pending.length, nextFirstInput - this.pendingStart));

    if (dropCount > 0) {
      this.pending = this.pending.slice(dropCount);
      this.pendingStart += dropCount;
    }

    return output.subarray(0, produced).slice();
  }
}
