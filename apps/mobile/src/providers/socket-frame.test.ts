import { describe, expect, it } from "vitest";

import { decodeSocketFrame, decodeUtf8 } from "./socket-frame";

const sample = 'café 街 \u{1f6b6} {"ok":true}';

describe("decodeUtf8", () => {
  it("decodes multi-byte sequences without a platform decoder", () => {
    expect(decodeUtf8(new TextEncoder().encode(sample))).toBe(sample);
  });

  it("decodes a payload longer than the chunk threshold", () => {
    const long = sample.repeat(2000);
    expect(decodeUtf8(new TextEncoder().encode(long))).toBe(long);
  });

  it("rejects a truncated sequence", () => {
    expect(() => decodeUtf8(new Uint8Array([0xe4, 0xb8]))).toThrow(/Truncated/);
  });

  it("rejects an invalid lead byte", () => {
    expect(() => decodeUtf8(new Uint8Array([0xff]))).toThrow(/lead byte/);
  });

  it("rejects an invalid continuation byte", () => {
    expect(() => decodeUtf8(new Uint8Array([0xe4, 0x28, 0xb8]))).toThrow(/continuation/);
  });
});

describe("decodeSocketFrame", () => {
  it("passes text frames through", () => {
    expect(decodeSocketFrame(sample)).toBe(sample);
  });

  it("decodes an ArrayBuffer frame", () => {
    expect(decodeSocketFrame(new TextEncoder().encode(sample).buffer)).toBe(sample);
  });

  it("decodes a view that does not start at the buffer origin", () => {
    const bytes = new TextEncoder().encode(`xx${sample}`);
    const view = new Uint8Array(bytes.buffer, 2, bytes.byteLength - 2);
    expect(decodeSocketFrame(view)).toBe(sample);
  });

  it("rejects a Blob instead of silently stringifying it", () => {
    expect(() => decodeSocketFrame(new Blob([sample]))).toThrow(/Unsupported WebSocket frame/);
  });
});
