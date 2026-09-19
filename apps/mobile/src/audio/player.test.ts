import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeAudio = vi.hoisted(() => ({
  queuesCreated: 0,
  queuesStopped: 0,
}));

vi.mock("react-native-audio-api", () => {
  class Queue {
    connect(): void {}
    disconnect(): void {}
    start(): void {}
    enqueueBuffer(): string {
      return "buffer";
    }
    stop(): void {
      nativeAudio.queuesStopped += 1;
    }
  }

  class AudioContext {
    readonly currentTime = 0;
    readonly destination = {};
    readonly sampleRate: number;

    constructor(options: { sampleRate: number }) {
      this.sampleRate = options.sampleRate;
    }

    createBuffer(_channels: number, length: number, sampleRate: number) {
      return {
        duration: length / sampleRate,
        copyToChannel(): void {},
      };
    }

    createBufferQueueSource(): Queue {
      nativeAudio.queuesCreated += 1;
      return new Queue();
    }

    close(): Promise<void> {
      return Promise.resolve();
    }
  }

  return { AudioBufferQueueSourceNode: Queue, AudioContext };
});

import { PcmPlayer } from "./player";

function samples(durationMs: number, sampleRateHz = 16_000): Int16Array {
  return new Int16Array((durationMs / 1000) * sampleRateHz);
}

describe("PcmPlayer generations", () => {
  beforeEach(() => {
    nativeAudio.queuesCreated = 0;
    nativeAudio.queuesStopped = 0;
  });

  it("replaces the native queue when a new utterance starts", () => {
    const player = new PcmPlayer();

    expect(
      player.playSamples({ utteranceId: "first", epoch: 0, sampleRateHz: 16_000, samples: samples(100) }),
    ).toBe("queued");
    expect(
      player.playSamples({ utteranceId: "second", epoch: 0, sampleRateHz: 16_000, samples: samples(100) }),
    ).toBe("queued");

    expect(nativeAudio.queuesCreated).toBe(2);
    expect(nativeAudio.queuesStopped).toBe(1);
    expect(
      player.enqueue({ utteranceId: "first", epoch: 0, sampleRateHz: 16_000, samples: samples(100) }),
    ).toBe("stale-utterance");
  });

  it("rejects late chunks after interruption and accepts the new epoch", () => {
    const player = new PcmPlayer();

    player.playSamples({ utteranceId: "first", epoch: 0, sampleRateHz: 16_000, samples: samples(100) });
    const nextEpoch = player.interrupt();

    expect(
      player.enqueue({ utteranceId: "first", epoch: 0, sampleRateHz: 16_000, samples: samples(100) }),
    ).toBe("stale-epoch");
    expect(
      player.playSamples({ utteranceId: "second", epoch: nextEpoch, sampleRateHz: 16_000, samples: samples(100) }),
    ).toBe("queued");
  });

  it("counts the incoming chunk when applying the queue limit", () => {
    const player = new PcmPlayer({ maxQueuedMs: 150 });

    player.beginUtterance("limited", 0);
    expect(
      player.enqueue({ utteranceId: "limited", epoch: 0, sampleRateHz: 16_000, samples: samples(100) }),
    ).toBe("queued");
    expect(
      player.enqueue({ utteranceId: "limited", epoch: 0, sampleRateHz: 16_000, samples: samples(100) }),
    ).toBe("queue-full");
  });
});
