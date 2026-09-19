import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  deletedUris: [] as string[],
  nowMs: 0,
}));

vi.mock("expo-file-system", () => ({
  File: class {
    constructor(private readonly uri: string) {}

    delete(): void {
      testState.deletedUris.push(this.uri);
    }
  },
}));

vi.mock("../session/clock", () => ({
  monotonicNowMs: () => testState.nowMs,
}));

import { FrameCaptureLoop } from "./frame-capture";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });

  return { promise, resolve: (value) => resolvePromise?.(value) };
}

describe("FrameCaptureLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    testState.deletedUris = [];
    testState.nowMs = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("deletes but does not publish a capture that finishes after stop", async () => {
    const picture = deferred<{
      uri: string;
      base64: string;
      width: number;
      height: number;
    }>();
    const frames: string[] = [];
    const camera = { takePictureAsync: vi.fn(() => picture.promise) };
    const loop = new FrameCaptureLoop({
      getCamera: () => camera as never,
      onFrame: (frame) => frames.push(frame.frameId),
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(camera.takePictureAsync).toHaveBeenCalledOnce();

    loop.stop();
    testState.nowMs = 250;
    picture.resolve({ uri: "file:///late.jpg", base64: "Zg==", width: 640, height: 480 });
    await Promise.resolve();
    await Promise.resolve();

    expect(testState.deletedUris).toEqual(["file:///late.jpg"]);
    expect(frames).toEqual([]);
    expect(loop.getStats().framesCaptured).toBe(0);
    expect(loop.getStats().running).toBe(false);
  });

  it("deletes a temporary file when the camera omits base64", async () => {
    const camera = {
      takePictureAsync: vi.fn(async () => ({ uri: "file:///empty.jpg", width: 640, height: 480 })),
    };
    const loop = new FrameCaptureLoop({ getCamera: () => camera as never });

    loop.start();
    testState.nowMs = 100;
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();
    loop.stop();

    expect(loop.getStats().lastError).toMatch(/no base64/);
    expect(testState.deletedUris).toEqual(["file:///empty.jpg"]);
  });
});
