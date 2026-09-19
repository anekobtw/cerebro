import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GeminiLiveMessage } from "../providers/gemini-live";
import { SessionClient, type SessionClientSnapshot } from "./client";

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  bufferedAmount = 0;
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(message: string): void {
    this.sent.push(message);
  }

  close(): void {
    if (this.readyState !== 3) {
      this.readyState = 3;
      this.onclose?.({} as CloseEvent);
    }
  }

  open(): void {
    this.onopen?.();
  }

  message(message: GeminiLiveMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

describe("SessionClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubEnv("EXPO_PUBLIC_GEMINI_API_KEY", "test-key");
    vi.stubEnv("EXPO_PUBLIC_GEMINI_LIVE_MODEL", "gemini-test-live");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("reconnects with the latest resumable session handle", async () => {
    const snapshots: SessionClientSnapshot[] = [];
    const client = new SessionClient({
      onAudio: vi.fn(),
      onText: vi.fn(),
      onInterrupted: vi.fn(),
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    });

    const started = client.start();
    const firstSocket = FakeWebSocket.instances[0];
    firstSocket.open();
    firstSocket.message({ setupComplete: {} });
    await started;
    firstSocket.message({
      sessionResumptionUpdate: { resumable: true, newHandle: "latest-handle" },
    });

    firstSocket.close();
    expect(snapshots.at(-1)?.connection).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(1_000);
    const secondSocket = FakeWebSocket.instances[1];
    secondSocket.open();
    expect(JSON.parse(secondSocket.sent[0])).toMatchObject({
      setup: { sessionResumption: { handle: "latest-handle" } },
    });

    secondSocket.message({ setupComplete: {} });
    expect(snapshots.at(-1)?.connection).toBe("connected");
    client.stop();
  });

  it("drops video while the provider socket is backlogged", async () => {
    const client = new SessionClient({
      onAudio: vi.fn(),
      onText: vi.fn(),
      onInterrupted: vi.fn(),
      onSnapshot: vi.fn(),
    });

    const started = client.start();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.message({ setupComplete: {} });
    await started;
    socket.bufferedAmount = 300 * 1_024;

    client.sendFrame({
      frameId: "frame-1",
      capturedAtMonotonicMs: 1,
      mimeType: "image/jpeg",
      width: 640,
      height: 480,
      jpegBase64: "image-data",
    });

    expect(socket.sent).toHaveLength(1);
    client.stop();
  });
});
