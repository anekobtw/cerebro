import { describe, expect, it } from "vitest";

import {
  CaptureGate,
  PendingFrameSlot,
  base64ByteLength,
  choosePictureSize,
  nextQuality,
  parsePictureSizes,
} from "./capture-policy";

describe("CaptureGate", () => {
  it("allows the first capture and then holds the one frame per second limit", () => {
    const gate = new CaptureGate(1000);

    expect(gate.decide(0)).toBe("start");
    gate.markStarted(0);
    expect(gate.decide(10)).toBe("capture-in-flight");

    gate.markFinished();
    expect(gate.decide(400)).toBe("too-soon");
    expect(gate.decide(1000)).toBe("start");
  });

  it("never starts a second capture while one is running, however long it takes", () => {
    const gate = new CaptureGate(1000);

    gate.markStarted(0);

    for (const now of [500, 1500, 9000]) {
      expect(gate.decide(now)).toBe("capture-in-flight");
    }

    gate.markFinished();
    expect(gate.decide(9000)).toBe("start");
  });
});

describe("PendingFrameSlot", () => {
  it("keeps the newest frame and counts the replaced ones", () => {
    const slot = new PendingFrameSlot<string>();

    slot.put("first");
    slot.put("second");
    slot.put("third");

    expect(slot.droppedFrames).toBe(2);
    expect(slot.take()).toBe("third");
    expect(slot.take()).toBeNull();
    expect(slot.hasFrame).toBe(false);
  });
});

describe("base64ByteLength", () => {
  it("reports the decoded size for both padding cases", () => {
    expect(base64ByteLength("")).toBe(0);
    expect(base64ByteLength("Zg==")).toBe(1);
    expect(base64ByteLength("Zm8=")).toBe(2);
    expect(base64ByteLength("Zm9v")).toBe(3);
    expect(base64ByteLength("Zm9vYmFy")).toBe(6);
  });

  it("sizes a 150 KiB frame payload", () => {
    const encoded = "A".repeat(204_800);

    expect(base64ByteLength(encoded)).toBe(153_600);
  });
});

describe("nextQuality", () => {
  it("lowers quality when a frame exceeds the transport budget", () => {
    expect(nextQuality(0.7, 200 * 1024, 150 * 1024)).toBe(0.6);
  });

  it("recovers slowly when frames are well under the budget", () => {
    expect(nextQuality(0.6, 40 * 1024, 150 * 1024)).toBe(0.65);
  });

  it("holds quality inside the readable range", () => {
    expect(nextQuality(0.35, 900 * 1024, 150 * 1024)).toBe(0.35);
    expect(nextQuality(0.9, 1024, 150 * 1024)).toBe(0.9);
  });

  it("leaves quality alone near the budget", () => {
    expect(nextQuality(0.6, 120 * 1024, 150 * 1024)).toBe(0.6);
  });
});

describe("choosePictureSize", () => {
  it("takes the smallest size that still reaches the target long edge", () => {
    const sizes = ["320x240", "640x480", "1280x720", "4080x3072"];

    expect(choosePictureSize(sizes, 768)).toBe("1280x720");
    expect(choosePictureSize(sizes, 640)).toBe("640x480");
  });

  it("falls back to the largest size when nothing reaches the target", () => {
    expect(choosePictureSize(["320x240", "640x480"], 4000)).toBe("640x480");
  });

  it("ignores labels the device reports in another shape", () => {
    expect(parsePictureSizes(["640x480", "hd", "3:4"]).map((size) => size.label)).toEqual(["640x480"]);
    expect(choosePictureSize(["hd"], 768)).toBeNull();
  });
});
