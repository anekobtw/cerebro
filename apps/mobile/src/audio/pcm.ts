/** Sample buffers are always backed by a plain ArrayBuffer so they can be handed to native audio nodes. */
export type FloatSamples = Float32Array<ArrayBuffer>;

export const PCM16_BYTES_PER_SAMPLE = 2;

export function floatToPcm16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);

  for (let index = 0; index < input.length; index += 1) {
    const sample = input[index];
    const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample;
    const scaled = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
    output[index] = scaled > 32767 ? 32767 : scaled < -32768 ? -32768 : scaled;
  }

  return output;
}

export function pcm16ToFloat(input: Int16Array): FloatSamples {
  const output = new Float32Array(input.length);

  for (let index = 0; index < input.length; index += 1) {
    const sample = input[index];
    output[index] = sample < 0 ? sample / 0x8000 : sample / 0x7fff;
  }

  return output;
}

export function pcm16ToBytes(input: Int16Array): Uint8Array {
  const bytes = new Uint8Array(input.length * PCM16_BYTES_PER_SAMPLE);

  for (let index = 0; index < input.length; index += 1) {
    const sample = input[index];
    bytes[index * 2] = sample & 0xff;
    bytes[index * 2 + 1] = (sample >> 8) & 0xff;
  }

  return bytes;
}

export function bytesToPcm16(bytes: Uint8Array): Int16Array {
  if (bytes.length % PCM16_BYTES_PER_SAMPLE !== 0) {
    throw new Error("PCM16 byte length must be even");
  }

  const output = new Int16Array(bytes.length / PCM16_BYTES_PER_SAMPLE);

  for (let index = 0; index < output.length; index += 1) {
    const low = bytes[index * 2];
    const high = bytes[index * 2 + 1];
    const value = (high << 8) | low;
    output[index] = value >= 0x8000 ? value - 0x10000 : value;
  }

  return output;
}

export function downmixToMono(channels: readonly FloatSamples[]): FloatSamples {
  if (channels.length === 0) {
    throw new Error("At least one channel is required");
  }

  if (channels.length === 1) {
    return channels[0];
  }

  const frames = channels[0].length;
  const output = new Float32Array(frames);

  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (const channel of channels) {
      sum += channel[frame];
    }
    output[frame] = sum / channels.length;
  }

  return output;
}

export function samplesForDurationMs(sampleRateHz: number, durationMs: number): number {
  return Math.round((sampleRateHz * durationMs) / 1000);
}

export function durationMsForSamples(sampleCount: number, sampleRateHz: number): number {
  return (sampleCount / sampleRateHz) * 1000;
}

export function peakLevel(input: Float32Array): number {
  let peak = 0;

  for (let index = 0; index < input.length; index += 1) {
    const magnitude = Math.abs(input[index]);
    if (magnitude > peak) {
      peak = magnitude;
    }
  }

  return peak;
}

export function generateTone(options: {
  frequencyHz: number;
  durationMs: number;
  sampleRateHz: number;
  amplitude?: number;
}): FloatSamples {
  const { frequencyHz, durationMs, sampleRateHz, amplitude = 0.3 } = options;
  const frames = samplesForDurationMs(sampleRateHz, durationMs);
  const output = new Float32Array(frames);
  const fadeFrames = Math.min(Math.floor(frames / 8), samplesForDurationMs(sampleRateHz, 10));

  for (let frame = 0; frame < frames; frame += 1) {
    const envelope =
      fadeFrames === 0
        ? 1
        : Math.min(1, frame / fadeFrames, (frames - frame) / fadeFrames);
    output[frame] =
      amplitude * envelope * Math.sin((2 * Math.PI * frequencyHz * frame) / sampleRateHz);
  }

  return output;
}
