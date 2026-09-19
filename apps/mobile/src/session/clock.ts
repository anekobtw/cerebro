const START_EPOCH_MS = Date.now();

type PerformanceLike = { now: () => number };

const performanceClock: PerformanceLike | null =
  typeof performance !== "undefined" && typeof performance.now === "function" ? performance : null;

export function monotonicNowMs(): number {
  if (performanceClock !== null) {
    return performanceClock.now();
  }

  return Date.now() - START_EPOCH_MS;
}

/**
 * Platform callbacks report wall-clock timestamps. The plan requires frame and
 * sample ages to be measured on the phone's monotonic clock, so convert once at
 * the boundary instead of subtracting clocks that drift apart.
 */
export function epochToMonotonicMs(
  epochMs: number,
  nowEpochMs: number,
  nowMonotonicMs: number,
): number {
  return nowMonotonicMs - (nowEpochMs - epochMs);
}
