import { decode } from "jpeg-js";
import { decodeBase64 } from "../audio/base64";

const GRID = 32;

/** Average decoded pixels into cells to reduce compression noise. */
export function sceneSignature(base64: string): Float32Array {
  const { data, width, height } = decode(decodeBase64(base64), {
    useTArray: true, formatAsRGBA: false, maxResolutionInMP: 20, maxMemoryUsageInMB: 128,
  });
  const result = new Float32Array(GRID * GRID * 3);
  const counts = new Uint32Array(GRID * GRID);
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const cell = Math.floor(y * GRID / height) * GRID + Math.floor(x * GRID / width);
      counts[cell] += 1;
      for (let c = 0; c < 3; c += 1) result[cell * 3 + c] += data[(y * width + x) * 3 + c];
    }
  }
  for (let cell = 0; cell < counts.length; cell += 1) {
    for (let c = 0; c < 3; c += 1) result[cell * 3 + c] /= counts[cell] || 1;
  }
  return result;
}

export function sceneChanged(previous: Float32Array | null, current: Float32Array): boolean {
  if (!previous) return true;
  let changed = 0;
  for (let i = 0; i < current.length; i += 3) {
    const difference = (Math.abs(current[i] - previous[i]) +
      Math.abs(current[i + 1] - previous[i + 1]) + Math.abs(current[i + 2] - previous[i + 2])) / 3;
    if (difference >= 24) changed += 1;
  }
  return changed / (GRID * GRID) >= 0.18;
}
