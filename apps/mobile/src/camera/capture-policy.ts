import {
  CAMERA_CAPTURE_INTERVAL_MS,
  CAMERA_INPUT_FPS,
  TARGET_IMAGE_BYTES,
} from "../session/media-limits";

export const MAX_INPUT_FPS = CAMERA_INPUT_FPS;
export const MIN_CAPTURE_INTERVAL_MS = CAMERA_CAPTURE_INTERVAL_MS;
export const TARGET_ENCODED_BYTES = TARGET_IMAGE_BYTES;
export const TARGET_LONG_EDGE_PX = 768;

export type CaptureDecision = "start" | "too-soon" | "capture-in-flight";

/** Enforces "one capture in progress, at most one frame per second". */
export class CaptureGate {
  private inFlight = false;
  private lastStartedAtMs: number | null = null;

  constructor(private readonly minIntervalMs: number = MIN_CAPTURE_INTERVAL_MS) {}

  get isCapturing(): boolean {
    return this.inFlight;
  }

  decide(nowMs: number): CaptureDecision {
    if (this.inFlight) {
      return "capture-in-flight";
    }

    if (this.lastStartedAtMs !== null && nowMs - this.lastStartedAtMs < this.minIntervalMs) {
      return "too-soon";
    }

    return "start";
  }

  markStarted(nowMs: number): void {
    this.inFlight = true;
    this.lastStartedAtMs = nowMs;
  }

  markFinished(): void {
    this.inFlight = false;
  }

  reset(): void {
    this.inFlight = false;
    this.lastStartedAtMs = null;
  }
}

/** Holds the newest frame only. An older unsent frame is replaced, never queued. */
export class PendingFrameSlot<T> {
  private frame: T | null = null;
  private replaced = 0;

  get droppedFrames(): number {
    return this.replaced;
  }

  get hasFrame(): boolean {
    return this.frame !== null;
  }

  put(frame: T): void {
    if (this.frame !== null) {
      this.replaced += 1;
    }

    this.frame = frame;
  }

  take(): T | null {
    const frame = this.frame;
    this.frame = null;
    return frame;
  }

  clear(): void {
    this.frame = null;
  }
}

export function base64ByteLength(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  let padding = 0;

  if (text.endsWith("==")) {
    padding = 2;
  } else if (text.endsWith("=")) {
    padding = 1;
  }

  return (text.length / 4) * 3 - padding;
}

/**
 * Keeps the encoded frame near the transport budget. Quality moves in small steps
 * so a single large frame cannot drop the image to an unreadable setting.
 */
export function nextQuality(
  currentQuality: number,
  encodedBytes: number,
  targetBytes: number = TARGET_ENCODED_BYTES,
): number {
  const clamp = (value: number): number => Math.min(0.9, Math.max(0.35, Math.round(value * 100) / 100));

  if (encodedBytes > targetBytes) {
    return clamp(currentQuality - 0.1);
  }

  if (encodedBytes < targetBytes * 0.5) {
    return clamp(currentQuality + 0.05);
  }

  return clamp(currentQuality);
}

export interface PictureSize {
  readonly label: string;
  readonly width: number;
  readonly height: number;
}

export function parsePictureSizes(labels: readonly string[]): PictureSize[] {
  const sizes: PictureSize[] = [];

  for (const label of labels) {
    const match = /^(\d+)x(\d+)$/.exec(label.trim());

    if (match === null) {
      continue;
    }

    sizes.push({ label, width: Number(match[1]), height: Number(match[2]) });
  }

  return sizes;
}

/**
 * Picks the smallest supported size whose long edge still reaches the target, so
 * sign text stays readable without paying for a full-resolution capture.
 */
export function choosePictureSize(
  labels: readonly string[],
  targetLongEdgePx: number = TARGET_LONG_EDGE_PX,
): string | null {
  const sizes = parsePictureSizes(labels);

  if (sizes.length === 0) {
    return null;
  }

  const longEdge = (size: PictureSize): number => Math.max(size.width, size.height);
  const atOrAbove = sizes
    .filter((size) => longEdge(size) >= targetLongEdgePx)
    .sort((left, right) => longEdge(left) - longEdge(right));

  if (atOrAbove.length > 0) {
    return atOrAbove[0].label;
  }

  return sizes.sort((left, right) => longEdge(right) - longEdge(left))[0].label;
}
