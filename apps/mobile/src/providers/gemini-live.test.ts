import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GeminiLiveClient, type GeminiLiveMessage } from "./gemini-live";

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  readonly url: string;
  binaryType: "blob" | "arraybuffer" = "blob";
  bufferedAmount = 0;
  readyState = FakeWebSocket.OPEN;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(message: string): void {
    this.sent.push(message);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  open(): void {
    this.onopen?.();
  }

  message(message: GeminiLiveMessage): void {
    this.onmessage?.({
      data: new TextEncoder().encode(JSON.stringify(message)).buffer,
    });
  }
}

describe("GeminiLiveClient", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubEnv("EXPO_PUBLIC_GEMINI_API_KEY", "test-key");
    vi.stubEnv("EXPO_PUBLIC_GEMINI_LIVE_MODEL", "gemini-test-live");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("configures audio, compression, transcription, and session resumption", () => {
    const onReady = vi.fn();
    const onMessage = vi.fn();
    const client = new GeminiLiveClient();

    client.connect(
      { onMessage, onReady },
      { sessionHandle: "resume-handle" },
    );

    const socket = FakeWebSocket.instances[0];
    expect(socket.url).toContain("key=test-key");
    socket.open();

    expect(JSON.parse(socket.sent[0])).toMatchObject({
      setup: {
        model: "models/gemini-test-live",
        generationConfig: { responseModalities: ["AUDIO"] },
        tools: [
          {
            functionDeclarations: expect.arrayContaining([
              expect.objectContaining({ name: "report_user_intent" }),
              expect.objectContaining({ name: "report_scene_observation" }),
            ]),
          },
        ],
        outputAudioTranscription: {},
        contextWindowCompression: { slidingWindow: {} },
        sessionResumption: { handle: "resume-handle" },
      },
    });

    const readyMessage = { setupComplete: {} };
    socket.message(readyMessage);
    expect(onReady).toHaveBeenCalledOnce();
    expect(onMessage).toHaveBeenCalledWith(readyMessage);
  });

  it("sends each realtime input in the provider wire format", () => {
    const client = new GeminiLiveClient();
    client.connect({ onMessage: vi.fn() });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    client.sendPcmAudio("audio-data");
    client.sendJpegFrame("image-data");
    client.sendText("repeat that");
    client.endAudioStream();
    client.sendToolResponses([
      {
        id: "tool-1",
        name: "report_user_intent",
        response: { accepted: true },
      },
    ]);

    expect(socket.sent.slice(1).map((message) => JSON.parse(message))).toEqual([
      {
        realtimeInput: {
          audio: { data: "audio-data", mimeType: "audio/pcm;rate=16000" },
        },
      },
      {
        realtimeInput: {
          video: { data: "image-data", mimeType: "image/jpeg" },
        },
      },
      { realtimeInput: { text: "repeat that" } },
      { realtimeInput: { audioStreamEnd: true } },
      {
        toolResponse: {
          functionResponses: [
            {
              id: "tool-1",
              name: "report_user_intent",
              response: { accepted: true },
            },
          ],
        },
      },
    ]);
  });

  it("reads binary frames as utf-8 rather than stringifying them", () => {
    const onMessage = vi.fn();
    const onProtocolError = vi.fn();
    const client = new GeminiLiveClient();

    client.connect({ onMessage, onProtocolError });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    expect(socket.binaryType).toBe("arraybuffer");

    const transcript = {
      serverContent: { outputTranscription: { text: "café 街 \u{1f6b6}" } },
    };
    socket.message(transcript);

    expect(onProtocolError).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledWith(transcript);
  });

  it("reports malformed provider messages and closes the socket", () => {
    const onProtocolError = vi.fn();
    const client = new GeminiLiveClient();
    client.connect({ onMessage: vi.fn(), onProtocolError });
    const socket = FakeWebSocket.instances[0];
    socket.open();

    socket.onmessage?.({ data: "not-json" });

    expect(onProtocolError).toHaveBeenCalledOnce();
    expect(socket.closed).toBe(true);
  });
});
