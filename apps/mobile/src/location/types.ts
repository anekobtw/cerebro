/** Mirrors the location shape in section 6.1 of HACKATHON_PLAN.md. */
export interface LocationSample {
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  capturedAtMonotonicMs: number;
  travelHeadingDeg: number | null;
}

/** Where the phone points. Kept apart from travel heading on purpose. */
export interface DeviceOrientationSample {
  trueHeadingDeg: number | null;
  magneticHeadingDeg: number;
  accuracyLevel: number;
  capturedAtMonotonicMs: number;
}
