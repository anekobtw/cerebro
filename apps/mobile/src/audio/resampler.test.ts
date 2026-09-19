import { describe, expect, it } from "vitest";

import type { FloatSamples } from "./pcm";
import { StreamingResampler } from "./resampler";

function tone(frequencyHz: number, sampleRateHz: number, frames: number): FloatSamples {
  const output = new Float32Array(frames);

  for (let frame = 0; frame < frames; frame += 1) {
    output[frame] = Math.sin((2 * Math.PI * frequencyHz * frame) / sampleRateHz);
  }

  return output;
}

function rms(samples: FloatSamples, from = 0): number {
  let sum = 0;
  for (let index = from; index < samples.length; index += 1) {
    sum += samples[index] * samples[index];
  }
  return Math.sqrt(sum / (samples.length - from));
}

describe("StreamingResampler", () => {
  it("passes audio through untouched when the rates match", () => {
    const resampler = new StreamingResampler(16_000, 16_000);
    const input = tone(440, 16_000, 100);

    expect(resampler.isPassthrough).toBe(true);
    expect(resampler.process(input)).toBe(input);
  });

  it("reconstructs a speech-band tone when downsampling 48 kHz to 16 kHz", () => {
    const resampler = new StreamingResampler(48_000, 16_000);
    const output = resampler.process(tone(300, 48_000, 48_000));
    const expected = tone(300, 16_000, output.length);

    expect(output.length).toBeGreaterThan(15_900);
    expect(output.length).toBeLessThanOrEqual(16_000);

    let worst = 0;
    for (let index = 100; index < output.length - 100; index += 1) {
      worst = Math.max(worst, Math.abs(output[index] - expected[index]));
    }

    expect(worst).toBeLessThan(0.02);
  });

  it("attenuates content above the output Nyquist instead of aliasing it down", () => {
    const resampler = new StreamingResampler(48_000, 16_000);
    const output = resampler.process(tone(11_000, 48_000, 48_000));

    expect(rms(output, 200)).toBeLessThan(0.1);
  });

  it("produces the same samples whether the stream arrives in one piece or in chunks", () => {
    const input = tone(700, 44_100, 44_100);
    const whole = new StreamingResampler(44_100, 16_000).process(input);

    const chunked = new StreamingResampler(44_100, 16_000);
    const pieces: number[] = [];
    for (let offset = 0; offset < input.length; offset += 441) {
      pieces.push(...Array.from(chunked.process(input.subarray(offset, offset + 441))));
    }

    expect(pieces.length).toBe(whole.length);
    for (let index = 0; index < whole.length; index += 1) {
      expect(Math.abs(pieces[index] - whole[index])).toBeLessThan(1e-6);
    }
  });

  it("upsamples 16 kHz playback audio to a 48 kHz output device", () => {
    const resampler = new StreamingResampler(16_000, 48_000);
    const output = resampler.process(tone(400, 16_000, 16_000));
    const expected = tone(400, 48_000, output.length);

    expect(output.length).toBeGreaterThan(47_800);

    let worst = 0;
    for (let index = 200; index < output.length - 200; index += 1) {
      worst = Math.max(worst, Math.abs(output[index] - expected[index]));
    }

    expect(worst).toBeLessThan(0.02);
  });

  it("restarts cleanly after reset", () => {
    const resampler = new StreamingResampler(48_000, 16_000);
    const input = tone(300, 48_000, 4800);
    const first = resampler.process(input);

    resampler.reset();
    const second = resampler.process(input);

    expect(Array.from(second)).toEqual(Array.from(first));
  });
});
