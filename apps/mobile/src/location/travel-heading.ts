export const MIN_TRAVEL_SPEED_MPS = 0.5;

export interface GpsCoordinates {
  heading: number | null;
  speed: number | null;
}

export function normalizeDeg(degrees: number): number {
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/**
 * Course over ground, not where the phone is pointed. Android reports a heading
 * of 0 with no movement, so a reading below walking speed is treated as unknown.
 */
export function travelHeadingDeg(
  coordinates: GpsCoordinates,
  minSpeedMps: number = MIN_TRAVEL_SPEED_MPS,
): number | null {
  const { heading, speed } = coordinates;

  if (heading === null || !Number.isFinite(heading) || heading < 0) {
    return null;
  }

  if (speed === null || !Number.isFinite(speed) || speed < minSpeedMps) {
    return null;
  }

  return normalizeDeg(heading);
}

export function headingDifferenceDeg(left: number, right: number): number {
  const difference = Math.abs(normalizeDeg(left) - normalizeDeg(right));
  return difference > 180 ? 360 - difference : difference;
}
