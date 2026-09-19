import * as Location from "expo-location";

import { epochToMonotonicMs, monotonicNowMs } from "../session/clock";
import { travelHeadingDeg } from "./travel-heading";
import type { DeviceOrientationSample, LocationSample } from "./types";

export interface LocationStats {
  running: boolean;
  permission: Location.PermissionStatus | null;
  samples: number;
  lastAccuracyM: number | null;
  bestAccuracyM: number | null;
  worstAccuracyM: number | null;
  lastSpeedMps: number | null;
  lastTravelHeadingDeg: number | null;
  samplesWithoutTravelHeading: number;
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
  private stats: LocationStats = {
    running: false,
    permission: null,
    samples: 0,
    lastAccuracyM: null,
    bestAccuracyM: null,
    worstAccuracyM: null,
    lastSpeedMps: null,
    lastTravelHeadingDeg: null,
    samplesWithoutTravelHeading: 0,
    lastDeviceHeadingDeg: null,
    lastSampleAgeMs: null,
    lastError: null,
  };

  constructor(private readonly options: LocationTrackerOptions = {}) {}

  getStats(): LocationStats {
    return { ...this.stats };
  }

  async start(): Promise<void> {
    if (this.locationSubscription !== null) {
      return;
    }

    const permission = await Location.requestForegroundPermissionsAsync();
    this.publish({ permission: permission.status });

    if (!permission.granted) {
      this.publish({ lastError: `Location permission ${permission.status}` });
      return;
    }

    try {
      this.locationSubscription = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: this.options.timeIntervalMs ?? 1000,
          distanceInterval: 0,
        },
        (position) => this.handlePosition(position),
      );

      this.headingSubscription = await Location.watchHeadingAsync((heading) => {
        const sample: DeviceOrientationSample = {
          trueHeadingDeg: heading.trueHeading < 0 ? null : heading.trueHeading,
          magneticHeadingDeg: heading.magHeading,
          accuracyLevel: heading.accuracy,
          capturedAtMonotonicMs: monotonicNowMs(),
        };

        this.options.onOrientation?.(sample);
        this.publish({ lastDeviceHeadingDeg: sample.trueHeadingDeg ?? sample.magneticHeadingDeg });
      });

      this.publish({ running: true, lastError: null });
    } catch (error) {
      this.publish({ lastError: error instanceof Error ? error.message : String(error) });
    }
  }

  stop(): void {
    this.locationSubscription?.remove();
    this.locationSubscription = null;
    this.headingSubscription?.remove();
    this.headingSubscription = null;
    this.publish({ running: false });
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

    this.options.onSample?.(sample);
    this.publish({
      samples: this.stats.samples + 1,
      lastAccuracyM: accuracy,
      bestAccuracyM:
        accuracy === null ? this.stats.bestAccuracyM : Math.min(this.stats.bestAccuracyM ?? accuracy, accuracy),
      worstAccuracyM:
        accuracy === null ? this.stats.worstAccuracyM : Math.max(this.stats.worstAccuracyM ?? accuracy, accuracy),
      lastSpeedMps: position.coords.speed,
      lastTravelHeadingDeg: heading,
      samplesWithoutTravelHeading:
        heading === null ? this.stats.samplesWithoutTravelHeading + 1 : this.stats.samplesWithoutTravelHeading,
      lastSampleAgeMs: Math.round(nowMonotonicMs - capturedAtMonotonicMs),
    });
  }

  private publish(patch: Partial<LocationStats>): void {
    this.stats = { ...this.stats, ...patch };
    this.options.onStats?.(this.getStats());
  }
}
