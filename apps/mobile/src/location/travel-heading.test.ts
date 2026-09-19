import { describe, expect, it } from "vitest";

import { headingDifferenceDeg, normalizeDeg, travelHeadingDeg } from "./travel-heading";

describe("travelHeadingDeg", () => {
  it("returns the course over ground while walking", () => {
    expect(travelHeadingDeg({ heading: 182.4, speed: 1.3 })).toBeCloseTo(182.4, 5);
  });

  it("returns nothing while standing still", () => {
    expect(travelHeadingDeg({ heading: 0, speed: 0 })).toBeNull();
    expect(travelHeadingDeg({ heading: 90, speed: 0.2 })).toBeNull();
  });

  it("rejects the placeholder values the platform reports when it has no fix", () => {
    expect(travelHeadingDeg({ heading: -1, speed: 2 })).toBeNull();
    expect(travelHeadingDeg({ heading: null, speed: 2 })).toBeNull();
    expect(travelHeadingDeg({ heading: 90, speed: null })).toBeNull();
    expect(travelHeadingDeg({ heading: Number.NaN, speed: 2 })).toBeNull();
  });

  it("wraps a heading into 0 to 360", () => {
    expect(normalizeDeg(370)).toBe(10);
    expect(normalizeDeg(-10)).toBe(350);
  });
});

describe("headingDifferenceDeg", () => {
  it("takes the short way around the circle", () => {
    expect(headingDifferenceDeg(350, 10)).toBe(20);
    expect(headingDifferenceDeg(10, 350)).toBe(20);
    expect(headingDifferenceDeg(0, 180)).toBe(180);
  });
});
