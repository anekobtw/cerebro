import { describe, expect, it } from "vitest";

import { epochToMonotonicMs, monotonicNowMs } from "./clock";

describe("epochToMonotonicMs", () => {
  it("keeps the age of a sample taken 250 ms ago", () => {
    const monotonic = epochToMonotonicMs(1_700_000_000_000, 1_700_000_000_250, 5_000);

    expect(monotonic).toBe(4_750);
  });

  it("maps a current timestamp onto the current monotonic reading", () => {
    expect(epochToMonotonicMs(1_000, 1_000, 42)).toBe(42);
  });
});

describe("monotonicNowMs", () => {
  it("never moves backwards", () => {
    const first = monotonicNowMs();
    const second = monotonicNowMs();

    expect(second).toBeGreaterThanOrEqual(first);
  });
});
