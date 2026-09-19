import { describe, expect, it } from "vitest";

import { decodeBase64, encodeBase64 } from "./base64";
import { PcmChunker } from "./chunker";
import {
  bytesToPcm16,
  downmixToMono,
  durationMsForSamples,
  floatToPcm16,
  generateTone,
  pcm16ToBytes,
  pcm16ToFloat,
  peakLevel,
  samplesForDurationMs,
} from "./pcm";

describe("floatToPcm16", () => {
  it("clamps samples outside the normalized range", () => {
    const pcm = floatToPcm16(Float32Array.from([2, -2, 1, -1, 0]));

    expect(Array.from(pcm)).toEqual([32767, -32768, 32767, -32768, 0]);
  });

  it("round-trips within one quantisation step", () => {
    const original = Float32Array.from([0.25, -0.25, 0.5, -0.5, 0.0123]);
    const restored = pcm16ToFloat(floatToPcm16(original));

    for (let index = 0; index < original.length; index += 1) {
      expect(Math.abs(restored[index] - original[index])).toBeLessThan(1 / 32767);
    }
  });
});

describe("pcm16 byte layout", () => {
  it("writes signed little-endian bytes", () => {
    const bytes = pcm16ToBytes(Int16Array.from([1, -1, 256, -32768]));

    expect(Array.from(bytes)).toEqual([0x01, 0x00, 0xff, 0xff, 0x00, 0x01, 0x00, 0x80]);
  });

  it("round-trips through bytes", () => {
    const samples = Int16Array.from([0, 1, -1, 32767, -32768, 12345]);

    expect(Array.from(bytesToPcm16(pcm16ToBytes(samples)))).toEqual(Array.from(samples));
  });

  it("rejects an odd byte count", () => {
    expect(() => bytesToPcm16(new Uint8Array(3))).toThrow(/even/);
  });
});

describe("chunk arithmetic", () => {
  it("matches the 16 kHz 100 ms budget from the plan", () => {
    const samples = samplesForDurationMs(16_000, 100);

    expect(samples).toBe(1600);
    expect(pcm16ToBytes(new Int16Array(samples)).length).toBe(3200);
    expect(durationMsForSamples(samples, 16_000)).toBe(100);
  });
});

describe("downmixToMono", () => {
  it("averages channels", () => {
    const mono = downmixToMono([Float32Array.from([1, 0]), Float32Array.from([0, 1])]);

    expect(Array.from(mono)).toEqual([0.5, 0.5]);
  });

  it("returns the single channel untouched", () => {
    const channel = Float32Array.from([0.5]);

    expect(downmixToMono([channel])).toBe(channel);
  });
});

describe("PcmChunker", () => {
  it("emits fixed size chunks and keeps the remainder", () => {
    const chunker = new PcmChunker(4);

    expect(chunker.push(Int16Array.from([1, 2, 3]))).toEqual([]);
    expect(chunker.pendingSamples).toBe(3);

    const chunks = chunker.push(Int16Array.from([4, 5, 6, 7, 8, 9]));

    expect(chunks.map((chunk) => Array.from(chunk))).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);
    expect(chunker.pendingSamples).toBe(1);
  });

  it("preserves sample order across many uneven pushes", () => {
    const chunker = new PcmChunker(1600);
    const emitted: number[] = [];
    let next = 0;

    for (let call = 0; call < 40; call += 1) {
      const block = new Int16Array(940 + (call % 7));
      for (let index = 0; index < block.length; index += 1) {
        block[index] = next % 32767;
        next += 1;
      }
      for (const chunk of chunker.push(block)) {
        expect(chunk.length).toBe(1600);
        emitted.push(...Array.from(chunk));
      }
    }

    expect(emitted.length % 1600).toBe(0);
    expect(emitted).toEqual(emitted.map((_, index) => index % 32767));
  });
});

describe("peakLevel", () => {
  it("reports the largest magnitude", () => {
    expect(peakLevel(Float32Array.from([0.1, -0.7, 0.2]))).toBeCloseTo(0.7, 6);
  });
});

describe("generateTone", () => {
  it("produces the requested duration and stays inside the amplitude", () => {
    const tone = generateTone({ frequencyHz: 440, durationMs: 250, sampleRateHz: 24_000, amplitude: 0.4 });

    expect(tone.length).toBe(6000);
    expect(peakLevel(tone)).toBeLessThanOrEqual(0.4 + 1e-6);
    expect(peakLevel(tone)).toBeGreaterThan(0.39);
    expect(tone[0]).toBe(0);
  });
});

describe("base64", () => {
  it("matches the RFC 4648 vectors, including both padding cases", () => {
    const vectors: ReadonlyArray<readonly [string, string]> = [
      ["", ""],
      ["f", "Zg=="],
      ["fo", "Zm8="],
      ["foo", "Zm9v"],
      ["foob", "Zm9vYg=="],
      ["fooba", "Zm9vYmE="],
      ["foobar", "Zm9vYmFy"],
    ];

    for (const [plain, encoded] of vectors) {
      const bytes = Uint8Array.from(plain, (character) => character.charCodeAt(0));

      expect(encodeBase64(bytes)).toBe(encoded);
      expect(Array.from(decodeBase64(encoded))).toEqual(Array.from(bytes));
    }
  });

  it("round-trips a full PCM chunk", () => {
    const samples = new Int16Array(1600);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = Math.round(30_000 * Math.sin(index / 9));
    }

    const bytes = pcm16ToBytes(samples);
    const encoded = encodeBase64(bytes);

    expect(encoded.length).toBe(Math.ceil(bytes.length / 3) * 4);
    expect(Array.from(decodeBase64(encoded))).toEqual(Array.from(bytes));
  });

  it("rejects a payload that is not a whole number of base64 quads", () => {
    expect(() => decodeBase64("Zm9")).toThrow(/multiple of four/);
  });
});
