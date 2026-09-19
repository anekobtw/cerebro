import type {
  DynamicRoute,
  NavigationPhase,
  PlaceCandidate,
} from "@blind-maps/contracts";
import {
  DEFAULT_DYNAMIC_GUIDANCE_CONFIG,
  bearingToTarget,
  createDynamicGuidanceState,
  describeRelativeDirection,
  distanceMeters,
  guidanceTarget,
  roundMeters,
  updateDynamicGuidance,
  type DynamicGuidanceConfig,
  type DynamicGuidanceState,
  type GuidanceLocation,
} from "@blind-maps/navigation";

import { providerConfig } from "../providers/config";
import { monotonicNowMs } from "../session/clock";
import { GoogleRoutesRequestError, requestDynamicRoute } from "./google-routes";
import { PlacesRequestError, describePlace, searchPlaces } from "./places";

export type DestinationSearchResult =
  | { kind: "candidate"; candidate: PlaceCandidate; description: string; remaining: number }
  | { kind: "none" }
  | { kind: "error"; message: string };

export type RouteStartResult =
  | { kind: "started"; announcement: string }
  | { kind: "error"; message: string };

export type RerouteResult =
  | { kind: "rerouted"; announcement: string }
  | { kind: "cooling_down" }
  | { kind: "exhausted"; announcement: string }
  | { kind: "error"; message: string };

export interface GuidanceUpdate {
  announcement: string | null;
  offRoute: boolean;
}

export class DynamicNavigator {
  private candidates: PlaceCandidate[] = [];
  private candidateIndex = 0;
  private route: DynamicRoute | null = null;
  private guidance: DynamicGuidanceState = createDynamicGuidanceState();
  private requestCount = 0;
  private rerouteCount = 0;
  private lastRerouteAtMs: number | null = null;
  private failureDetail: string | null = null;
  private readonly guidanceConfig: DynamicGuidanceConfig = {
    ...DEFAULT_DYNAMIC_GUIDANCE_CONFIG,
    arrivalRadiusM: providerConfig.navArrivalRadiusM,
  };

  get configured(): boolean {
    return (
      providerConfig.googlePlacesEnabled &&
      providerConfig.googleRoutesEnabled &&
      Boolean(providerConfig.googleMapsApiKey)
    );
  }

  get activeRoute(): DynamicRoute | null {
    return this.route;
  }

  get phase(): NavigationPhase | null {
    return this.route ? this.guidance.phase : null;
  }

  get currentStepId(): string | null {
    return this.route ? `step-${this.guidance.stepIndex + 1}-of-${this.route.steps.length}` : null;
  }

  get routeId(): string | null {
    return this.route?.destination.placeId ?? null;
  }

  get destinationName(): string | null {
    return this.route?.destination.name ?? null;
  }

  get warnings(): string[] {
    return this.route?.warnings ?? [];
  }

  get routeRequestCount(): number {
    return this.requestCount;
  }

  get lastFailureDetail(): string | null {
    return this.failureDetail;
  }

  get lastInstruction(): string | null {
    return this.guidance.lastInstruction;
  }

  reset(): void {
    this.candidates = [];
    this.candidateIndex = 0;
    this.route = null;
    this.guidance = createDynamicGuidanceState();
    this.rerouteCount = 0;
    this.lastRerouteAtMs = null;
    this.failureDetail = null;
  }

  async search(query: string, origin: GuidanceLocation): Promise<DestinationSearchResult> {
    if (!this.configured) {
      return {
        kind: "error",
        message: "Destination search is not set up on this phone.",
      };
    }

    try {
      this.candidates = await searchPlaces({
        apiKey: providerConfig.googleMapsApiKey,
        query,
        origin,
        radiusM: providerConfig.googlePlacesSearchRadiusM,
        regionCode: providerConfig.googlePlacesRegionCode,
        timeoutMs: providerConfig.googleMapsRequestTimeoutMs,
      });
    } catch (error) {
      this.failureDetail = error instanceof Error ? error.message : String(error);
      return {
        kind: "error",
        message:
          error instanceof PlacesRequestError && error.kind === "timeout"
            ? "The place search timed out."
            : "I could not search for that place.",
      };
    }

    this.candidateIndex = 0;
    this.failureDetail = null;
    return this.currentCandidate(origin);
  }

  nextCandidate(origin: GuidanceLocation): DestinationSearchResult {
    this.candidateIndex += 1;
    return this.currentCandidate(origin);
  }

  async start(candidate: PlaceCandidate, origin: GuidanceLocation): Promise<RouteStartResult> {
    let route: DynamicRoute;
    try {
      this.requestCount += 1;
      route = await requestDynamicRoute({
        apiKey: providerConfig.googleMapsApiKey,
        origin,
        destination: candidate,
        timeoutMs: providerConfig.googleMapsRequestTimeoutMs,
      });
    } catch (error) {
      this.failureDetail = error instanceof Error ? error.message : String(error);
      return {
        kind: "error",
        message:
          error instanceof GoogleRoutesRequestError && error.kind === "timeout"
            ? "The route request timed out."
            : "I could not build a walking route there.",
      };
    }

    this.route = route;
    // The opening announcement already reads the first step, so mark it spoken
    // rather than letting the first location sample repeat it.
    this.guidance = {
      ...createDynamicGuidanceState(),
      announcedStepIndex: 0,
      lastInstruction: route.steps[0].instructionText,
    };
    this.failureDetail = null;
    return { kind: "started", announcement: this.openingAnnouncement(route) };
  }

  handleLocation(sample: GuidanceLocation): GuidanceUpdate {
    if (!this.route) return { announcement: null, offRoute: false };
    const update = updateDynamicGuidance(this.guidance, this.route, sample, this.guidanceConfig);
    this.guidance = update.state;
    return { announcement: update.announcement, offRoute: update.offRoute };
  }

  async reroute(origin: GuidanceLocation): Promise<RerouteResult> {
    const route = this.route;
    if (!route) return { kind: "cooling_down" };

    const now = monotonicNowMs();
    if (
      this.lastRerouteAtMs !== null &&
      now - this.lastRerouteAtMs < providerConfig.navRerouteCooldownMs
    ) {
      return { kind: "cooling_down" };
    }
    if (this.rerouteCount >= providerConfig.navMaxReroutesPerSession) {
      this.lastRerouteAtMs = now;
      return {
        kind: "exhausted",
        announcement: `You are off the route and I have used all my route updates. ${route.destination.name} is about ${roundMeters(distanceMeters(origin, route.destination.position))} metres away.`,
      };
    }

    this.lastRerouteAtMs = now;
    this.rerouteCount += 1;
    const result = await this.start(route.destination, origin);
    if (result.kind === "error") return { kind: "error", message: result.message };
    // Mid-walk, one word beats a distance and duration summary. Clearing the
    // announced step lets the next location sample speak the new first turn.
    this.guidance = { ...this.guidance, announcedStepIndex: null };
    return { kind: "rerouted", announcement: "Recalculating." };
  }

  describePosition(sample: GuidanceLocation, deviceHeadingDeg: number | null): string {
    const route = this.route;
    if (!route) return "I do not have a route yet. Say repeat to choose a destination.";

    const remaining = roundMeters(distanceMeters(sample, route.destination.position));
    const heading = sample.travelHeadingDeg ?? deviceHeadingDeg;
    const instruction = this.guidance.lastInstruction;
    const prefix = instruction ? `${instruction} ` : "";

    if (heading === null) {
      return `${prefix}${route.destination.name} is about ${remaining} metres away. I cannot tell which way you are facing.`;
    }

    const target = guidanceTarget(this.guidance, route);
    const direction = describeRelativeDirection(bearingToTarget(sample, target), heading);
    return `${prefix}${route.destination.name} is about ${remaining} metres away, ${direction}.`;
  }

  private currentCandidate(origin: GuidanceLocation): DestinationSearchResult {
    const candidate = this.candidates[this.candidateIndex];
    if (!candidate) return { kind: "none" };
    return {
      kind: "candidate",
      candidate,
      description: describePlace(candidate, origin),
      remaining: this.candidates.length - this.candidateIndex - 1,
    };
  }

  private openingAnnouncement(route: DynamicRoute): string {
    const minutes =
      route.estimatedDurationSeconds === null
        ? null
        : Math.max(1, Math.round(route.estimatedDurationSeconds / 60));
    const walk = minutes === null ? "" : ` That is about ${minutes} minute${minutes === 1 ? "" : "s"} of walking.`;
    return `Heading to ${route.destination.name}, about ${roundMeters(route.distanceMeters)} metres.${walk} ${route.steps[0].instructionText}`;
  }
}
