import * as Location from "expo-location";

import { epochToMonotonicMs, monotonicNowMs } from "../session/clock";
import { travelHeadingDeg } from "./travel-heading";
import type { DeviceOrientationSample, LocationSample } from "./types";

export interface LocationStats {
  running: boolean;
  starting: boolean;
  permission: Location.PermissionStatus | null;
  samples: number;
  firstFixDelayMs: number | null;
  lastAccuracyM: number | null;
  bestAccuracyM: number | null;
  worstAccuracyM: number | null;
  lastSpeedMps: number | null;
  lastTravelHeadingDeg: number | null;
  samplesWithoutTravelHeading: number;
  travelHeadingAvailabilityPercent: number;
  lastDeviceHeadingDeg: number | null;
  lastSampleAgeMs: number | null;
  lastError: string | null;
}

export interface LocationTrackerOptions {
  onSample?: (sample: LocationSample) => void;
  onOrientation?: (sample: DeviceOrientationSample) => void;
  onStats?: (stats: LocationStats) => void;
  timeIntervalMs?: number;
}

export class LocationTracker {
  private locationSubscription: Location.LocationSubscription | null = null;
  private headingSubscription: Location.LocationSubscription | null = null;
  private runId = 0;
  private trackingStartedAtMs: number | null = null;
  private stats: LocationStats = {
    running: false,
    starting: false,
    permission: null,
    samples: 0,
    firstFixDelayMs: null,
    lastAccuracyM: null,
    bestAccuracyM: null,
    worstAccuracyM: null,
    lastSpeedMps: null,
    lastTravelHeadingDeg: null,
    samplesWithoutTravelHeading: 0,
    travelHeadingAvailabilityPercent: 0,
    lastDeviceHeadingDeg: null,
    lastSampleAgeMs: null,
    lastError: null,
  };

  constructor(private readonly options: LocationTrackerOptions = {}) {}

  getStats(): LocationStats {
    return { ...this.stats };
  }

  async start(): Promise<void> {
    if (this.locationSubscription !== null || this.stats.starting) {
      return;
    }

    this.runId += 1;
    const currentRunId = this.runId;
    this.trackingStartedAtMs = monotonicNowMs();
    this.publish({
      running: false,
      starting: true,
      samples: 0,
      firstFixDelayMs: null,
      lastAccuracyM: null,
      bestAccuracyM: null,
      worstAccuracyM: null,
      lastSpeedMps: null,
      lastTravelHeadingDeg: null,
      samplesWithoutTravelHeading: 0,
      travelHeadingAvailabilityPercent: 0,
      lastDeviceHeadingDeg: null,
      lastSampleAgeMs: null,
      lastError: null,
    });

    let permission: Location.LocationPermissionResponse;

    try {
      permission = await Location.requestForegroundPermissionsAsync();
    } catch (error) {
      if (currentRunId === this.runId) {
        this.publish({
          starting: false,
          lastError: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (currentRunId !== this.runId) {
      return;
    }

    this.publish({ permission: permission.status });

    if (!permission.granted) {
      this.publish({ starting: false, lastError: `Location permission ${permission.status}` });
      return;
    }

    try {
      const locationSubscription = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: this.options.timeIntervalMs ?? 1000,
          distanceInterval: 0,
        },
        (position) => {
          if (currentRunId === this.runId) {
            this.handlePosition(position);
          }
        },
      );

      if (currentRunId !== this.runId) {
        locationSubscription.remove();
        return;
      }

      this.locationSubscription = locationSubscription;

      const headingSubscription = await Location.watchHeadingAsync((heading) => {
        if (currentRunId !== this.runId) {
          return;
        }

        const sample: DeviceOrientationSample = {
          trueHeadingDeg: heading.trueHeading < 0 ? null : heading.trueHeading,
          magneticHeadingDeg: heading.magHeading,
          accuracyLevel: heading.accuracy,
          capturedAtMonotonicMs: monotonicNowMs(),
        };

        this.options.onOrientation?.(sample);
        this.publish({ lastDeviceHeadingDeg: sample.trueHeadingDeg ?? sample.magneticHeadingDeg });
      });

      if (currentRunId !== this.runId) {
        headingSubscription.remove();
        this.locationSubscription?.remove();
        this.locationSubscription = null;
        return;
      }

      this.headingSubscription = headingSubscription;
      this.publish({ running: true, starting: false, lastError: null });
    } catch (error) {
      if (currentRunId === this.runId) {
        this.locationSubscription?.remove();
        this.locationSubscription = null;
        this.headingSubscription?.remove();
        this.headingSubscription = null;
        this.publish({
          running: false,
          starting: false,
          lastError: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  stop(): void {
    this.runId += 1;
    this.locationSubscription?.remove();
    this.locationSubscription = null;
    this.headingSubscription?.remove();
    this.headingSubscription = null;
    this.trackingStartedAtMs = null;
    this.publish({ running: false, starting: false });
  }

  private handlePosition(position: Location.LocationObject): void {
    const nowMonotonicMs = monotonicNowMs();
    const capturedAtMonotonicMs = epochToMonotonicMs(position.timestamp, Date.now(), nowMonotonicMs);
    const heading = travelHeadingDeg(position.coords);

    const sample: LocationSample = {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracyM: position.coords.accuracy,
      capturedAtMonotonicMs,
      travelHeadingDeg: heading,
    };

    const accuracy = position.coords.accuracy;
    const sampleCount = this.stats.samples + 1;
    const samplesWithoutTravelHeading =
      heading === null ? this.stats.samplesWithoutTravelHeading + 1 : this.stats.samplesWithoutTravelHeading;

    this.options.onSample?.(sample);
    this.publish({
      samples: sampleCount,
      firstFixDelayMs:
        this.stats.firstFixDelayMs ??
        (this.trackingStartedAtMs === null ? null : Math.round(nowMonotonicMs - this.trackingStartedAtMs)),
      lastAccuracyM: accuracy,
      bestAccuracyM:
        accuracy === null ? this.stats.bestAccuracyM : Math.min(this.stats.bestAccuracyM ?? accuracy, accuracy),
      worstAccuracyM:
        accuracy === null ? this.stats.worstAccuracyM : Math.max(this.stats.worstAccuracyM ?? accuracy, accuracy),
      lastSpeedMps: position.coords.speed,
      lastTravelHeadingDeg: heading,
      samplesWithoutTravelHeading,
      travelHeadingAvailabilityPercent: ((sampleCount - samplesWithoutTravelHeading) / sampleCount) * 100,
      lastSampleAgeMs: Math.round(nowMonotonicMs - capturedAtMonotonicMs),
    });
  }

  private publish(patch: Partial<LocationStats>): void {
    this.stats = { ...this.stats, ...patch };
    this.options.onStats?.(this.getStats());
  }
}
