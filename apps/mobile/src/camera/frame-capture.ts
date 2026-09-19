import type { CameraView } from "expo-camera";
import { File } from "expo-file-system";

import { monotonicNowMs } from "../session/clock";
import {
  CaptureGate,
  MIN_CAPTURE_INTERVAL_MS,
  PendingFrameSlot,
  TARGET_ENCODED_BYTES,
  base64ByteLength,
  nextQuality,
} from "./capture-policy";
import type { CameraFrame } from "./types";

const POLL_INTERVAL_MS = 100;

export interface FrameCaptureStats {
  running: boolean;
  framesCaptured: number;
  framesReplaced: number;
  capturesSkipped: number;
  lastFrameId: string | null;
  lastWidth: number | null;
  lastHeight: number | null;
  lastEncodedBytes: number;
  lastCaptureDurationMs: number | null;
  medianCaptureDurationMs: number | null;
  slowestCaptureDurationMs: number;
  captureRateFps: number | null;
  quality: number;
  temporaryFilesDeleted: number;
  temporaryFilesLeft: number;
  lastError: string | null;
}

export interface FrameCaptureOptions {
  getCamera: () => CameraView | null;
  onFrame?: (frame: CameraFrame) => void;
  onStats?: (stats: FrameCaptureStats) => void;
  intervalMs?: number;
  targetEncodedBytes?: number;
  initialQuality?: number;
}

/**
 * Captures frames from a mounted preview without any shutter action. One capture
 * runs at a time and only the newest completed frame is kept for the session to
 * pick up, so a slow capture cannot build a backlog.
 */
export class FrameCaptureLoop {
  private readonly gate: CaptureGate;
  private readonly slot = new PendingFrameSlot<CameraFrame>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private runId = 0;
  private frameCounter = 0;
  private captureDurationsMs: number[] = [];
  private captureIntervalsMs: number[] = [];
  private previousCaptureAtMs: number | null = null;
  private stats: FrameCaptureStats;

  constructor(private readonly options: FrameCaptureOptions) {
    this.gate = new CaptureGate(options.intervalMs ?? MIN_CAPTURE_INTERVAL_MS);
    this.stats = {
      running: false,
      framesCaptured: 0,
      framesReplaced: 0,
      capturesSkipped: 0,
      lastFrameId: null,
      lastWidth: null,
      lastHeight: null,
      lastEncodedBytes: 0,
      lastCaptureDurationMs: null,
      medianCaptureDurationMs: null,
      slowestCaptureDurationMs: 0,
      captureRateFps: null,
      quality: options.initialQuality ?? 0.6,
      temporaryFilesDeleted: 0,
      temporaryFilesLeft: 0,
      lastError: null,
    };
  }

  getStats(): FrameCaptureStats {
    return { ...this.stats, framesReplaced: this.slot.droppedFrames };
  }

  takeFrame(): CameraFrame | null {
    return this.slot.take();
  }

  start(): void {
    if (this.timer !== null) {
      return;
    }

    this.runId += 1;
    const currentRunId = this.runId;
    this.captureDurationsMs = [];
    this.captureIntervalsMs = [];
    this.previousCaptureAtMs = null;
    this.timer = setInterval(() => {
      void this.tick(currentRunId);
    }, POLL_INTERVAL_MS);
    this.publish({
      running: true,
      lastError: null,
      lastCaptureDurationMs: null,
      medianCaptureDurationMs: null,
      captureRateFps: null,
    });
  }

  stop(): void {
    this.runId += 1;

    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.slot.clear();
    this.publish({ running: false });
  }

  private async tick(currentRunId: number): Promise<void> {
    const decision = this.gate.decide(monotonicNowMs());

    if (decision !== "start") {
      if (decision === "capture-in-flight") {
        this.stats.capturesSkipped += 1;
      }
      return;
    }

    const camera = this.options.getCamera();

    if (camera === null) {
      return;
    }

    const startedAtMs = monotonicNowMs();
    this.gate.markStarted(startedAtMs);

    let temporaryUri: string | null = null;

    try {
      const picture = await camera.takePictureAsync({
        base64: true,
        quality: this.stats.quality,
        exif: false,
      });
      temporaryUri = picture.uri;

      const capturedAtMonotonicMs = monotonicNowMs();

      if (currentRunId !== this.runId || this.timer === null) {
        return;
      }

      if (picture.base64 === undefined) {
        this.publish({ lastError: "Camera returned no base64 payload" });
        return;
      }

      this.deleteTemporaryFile(temporaryUri);
      temporaryUri = null;

      this.frameCounter += 1;
      const encodedBytes = base64ByteLength(picture.base64);
      const frame: CameraFrame = {
        frameId: `frame-${this.frameCounter}`,
        capturedAtMonotonicMs,
        mimeType: "image/jpeg",
        width: picture.width,
        height: picture.height,
        jpegBase64: picture.base64,
      };

      this.slot.put(frame);
      this.options.onFrame?.(frame);

      const durationMs = Math.round(capturedAtMonotonicMs - startedAtMs);
      this.captureDurationsMs.push(durationMs);

      if (this.previousCaptureAtMs !== null) {
        this.captureIntervalsMs.push(capturedAtMonotonicMs - this.previousCaptureAtMs);
      }
      this.previousCaptureAtMs = capturedAtMonotonicMs;

      const meanIntervalMs = mean(this.captureIntervalsMs);

      this.publish({
        framesCaptured: this.stats.framesCaptured + 1,
        lastFrameId: frame.frameId,
        lastWidth: frame.width,
        lastHeight: frame.height,
        lastEncodedBytes: encodedBytes,
        lastCaptureDurationMs: durationMs,
        medianCaptureDurationMs: median(this.captureDurationsMs),
        slowestCaptureDurationMs: Math.max(this.stats.slowestCaptureDurationMs, durationMs),
        captureRateFps: meanIntervalMs === null ? null : 1000 / meanIntervalMs,
        quality: nextQuality(
          this.stats.quality,
          encodedBytes,
          this.options.targetEncodedBytes ?? TARGET_ENCODED_BYTES,
        ),
        lastError: null,
      });
    } catch (error) {
      if (currentRunId === this.runId) {
        this.publish({ lastError: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (temporaryUri !== null) {
        this.deleteTemporaryFile(temporaryUri);
      }
      this.gate.markFinished();
    }
  }

  private deleteTemporaryFile(uri: string): void {
    try {
      new File(uri).delete();
      this.stats.temporaryFilesDeleted += 1;
    } catch {
      this.stats.temporaryFilesLeft += 1;
    }
  }

  private publish(patch: Partial<FrameCaptureStats>): void {
    this.stats = { ...this.stats, ...patch };
    this.options.onStats?.(this.getStats());
  }
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
