import type {
  DynamicRoute,
  DynamicRouteStep,
  GeoPoint,
  PlaceCandidate,
  RouteManifest,
  SessionOutdoorRoute,
} from "@cerebro/contracts";
import {
  distanceMeters,
  distanceToPolylineMeters,
  polylineLengthMeters,
} from "@cerebro/navigation";
import { z } from "zod";

const COMPUTE_ROUTES_URL =
  "https://routes.googleapis.com/directions/v2:computeRoutes";

export const GOOGLE_ROUTES_FIELD_MASK = [
  "routes.distanceMeters",
  "routes.duration",
  "routes.polyline.encodedPolyline",
  "routes.legs.steps.distanceMeters",
  "routes.legs.steps.startLocation",
  "routes.legs.steps.endLocation",
  "routes.legs.steps.navigationInstruction",
  "routes.warnings",
].join(",");

const latLngSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
});

const routeResponseSchema = z.object({
  routes: z
    .array(
      z.object({
        distanceMeters: z.number().finite().nonnegative(),
        duration: z.string().optional(),
        polyline: z.object({ encodedPolyline: z.string().min(1) }),
        warnings: z.array(z.string()).optional().default([]),
        legs: z
          .array(
            z.object({
              steps: z
                .array(
                  z.object({
                    distanceMeters: z.number().finite().nonnegative().optional(),
                    startLocation: z.object({ latLng: latLngSchema }).optional(),
                    endLocation: z.object({ latLng: latLngSchema }).optional(),
                    navigationInstruction: z
                      .object({
                        instructions: z.string().optional(),
                        maneuver: z.string().optional(),
                      })
                      .optional(),
                  }),
                )
                .optional()
                .default([]),
            }),
          )
          .optional()
          .default([]),
      }),
    )
    .min(1),
});

export interface GoogleRouteCandidate {
  geometry: GeoPoint[];
  steps: DynamicRouteStep[];
  distanceMeters: number;
  durationSeconds: number | null;
  warnings: string[];
  snappedStart: GeoPoint;
  snappedEnd: GeoPoint;
}

export interface GoogleRouteAcceptance {
  accepted: boolean;
  reason: string | null;
}

export interface OutdoorRouteSelection {
  route: SessionOutdoorRoute;
  requestCount: number;
  rejectionReason: string | null;
}

export interface SelectOutdoorRouteOptions {
  enabled: boolean;
  apiKey?: string;
  manifest: RouteManifest;
  start: GeoPoint;
  timeoutMs: number;
  maxCorridorDistanceM?: number;
  maxEndpointSnapDistanceM?: number;
  fetchImpl?: typeof fetch;
}

export class GoogleRoutesRequestError extends Error {
  constructor(
    readonly kind: "timeout" | "api_error",
    message: string,
  ) {
    super(message);
    this.name = "GoogleRoutesRequestError";
  }
}

export async function selectOutdoorRoute(
  options: SelectOutdoorRouteOptions,
): Promise<OutdoorRouteSelection> {
  const surveyedGeometry = surveyedOutdoorGeometry(options.manifest);
  const fallback = (
    fallbackReason: SessionOutdoorRoute["fallbackReason"],
    requestCount: number,
    rejectionReason: string | null = null,
  ): OutdoorRouteSelection => ({
    route: {
      source: "surveyed",
      surveyedRouteId: options.manifest.id,
      surveyedRouteVersion: options.manifest.version,
      handoffAnchorId: options.manifest.handoffAnchorId,
      outdoorGeometry: surveyedGeometry,
      distanceMeters: polylineLengthMeters(surveyedGeometry),
      estimatedDurationSeconds: null,
      providerWarnings: [],
      fallbackReason,
    },
    requestCount,
    rejectionReason,
  });

  if (!options.enabled || !options.apiKey) return fallback("disabled", 0);

  const handoff = options.manifest.anchors.find(
    (anchor) => anchor.id === options.manifest.handoffAnchorId,
  )?.position;
  if (!handoff) {
    return fallback("route_rejected", 0, "Surveyed handoff has no outdoor position");
  }

  let candidate: GoogleRouteCandidate;
  try {
    candidate = await requestGoogleWalkingRoute({
      apiKey: options.apiKey,
      origin: options.start,
      destination: handoff,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    });
  } catch (error) {
    const reason =
      error instanceof GoogleRoutesRequestError && error.kind === "timeout"
        ? "timeout"
        : "api_error";
    return fallback(reason, 1, error instanceof Error ? error.message : String(error));
  }

  const acceptance = acceptGoogleRoute(candidate, {
    start: options.start,
    handoff,
    surveyedGeometry,
    maxCorridorDistanceM: options.maxCorridorDistanceM ?? 20,
    maxEndpointSnapDistanceM: options.maxEndpointSnapDistanceM ?? 15,
  });
  if (!acceptance.accepted) {
    return fallback("route_rejected", 1, acceptance.reason);
  }

  return {
    route: {
      source: "google_routes",
      surveyedRouteId: options.manifest.id,
      surveyedRouteVersion: options.manifest.version,
      handoffAnchorId: options.manifest.handoffAnchorId,
      outdoorGeometry: candidate.geometry,
      distanceMeters: candidate.distanceMeters,
      estimatedDurationSeconds: candidate.durationSeconds,
      providerWarnings: candidate.warnings,
    },
    requestCount: 1,
    rejectionReason: null,
  };
}

export async function requestGoogleWalkingRoute(options: {
  apiKey: string;
  origin: GeoPoint;
  destination: GeoPoint;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): Promise<GoogleRouteCandidate> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(COMPUTE_ROUTES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": options.apiKey,
        "X-Goog-FieldMask": GOOGLE_ROUTES_FIELD_MASK,
      },
      body: JSON.stringify({
        // Callers pass richer objects than GeoPoint, and the API rejects any
        // extra field inside latLng, so send the two coordinates only.
        origin: { location: { latLng: latLngOf(options.origin) } },
        destination: { location: { latLng: latLngOf(options.destination) } },
        travelMode: "WALK",
        languageCode: "en-US",
        units: "METRIC",
        computeAlternativeRoutes: false,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new GoogleRoutesRequestError("timeout", "Google Routes request timed out");
    }
    throw new GoogleRoutesRequestError(
      "api_error",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new GoogleRoutesRequestError(
      "api_error",
      `Google Routes returned HTTP ${response.status}`,
    );
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new GoogleRoutesRequestError("api_error", "Google Routes returned invalid JSON");
  }
  const parsed = routeResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new GoogleRoutesRequestError(
      "api_error",
      "Google Routes response did not match the expected schema",
    );
  }

  const route = parsed.data.routes[0];
  let geometry: GeoPoint[];
  try {
    geometry = decodeGooglePolyline(route.polyline.encodedPolyline);
  } catch (error) {
    throw new GoogleRoutesRequestError(
      "api_error",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (geometry.length < 2) {
    throw new GoogleRoutesRequestError("api_error", "Google route has no usable geometry");
  }
  return {
    geometry,
    steps: walkingSteps(route.legs),
    distanceMeters: route.distanceMeters,
    durationSeconds: parseDurationSeconds(route.duration),
    warnings: route.warnings,
    snappedStart: geometry[0],
    snappedEnd: geometry[geometry.length - 1],
  };
}

/**
 * The spoken-destination path. It has no surveyed corridor to check the result
 * against, so the route is used as returned and guidance stops at the arrival
 * radius rather than claiming to reach a door.
 */
export async function requestDynamicRoute(options: {
  apiKey: string | undefined;
  origin: GeoPoint;
  destination: PlaceCandidate;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): Promise<DynamicRoute> {
  if (!options.apiKey) {
    throw new GoogleRoutesRequestError("api_error", "Google Routes is not configured");
  }

  const candidate = await requestGoogleWalkingRoute({
    apiKey: options.apiKey,
    origin: options.origin,
    destination: options.destination.position,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  });

  const steps =
    candidate.steps.length > 0
      ? candidate.steps
      : [
          {
            instructionText: `Walk toward ${options.destination.name}.`,
            maneuver: null,
            distanceMeters: candidate.distanceMeters,
            start: candidate.snappedStart,
            end: candidate.snappedEnd,
          },
        ];

  return {
    destination: options.destination,
    geometry: candidate.geometry,
    steps,
    distanceMeters: candidate.distanceMeters,
    estimatedDurationSeconds: candidate.durationSeconds,
    warnings: candidate.warnings,
  };
}

function walkingSteps(
  legs: { steps: { distanceMeters?: number; startLocation?: { latLng: GeoPoint }; endLocation?: { latLng: GeoPoint }; navigationInstruction?: { instructions?: string; maneuver?: string } }[] }[],
): DynamicRouteStep[] {
  const steps: DynamicRouteStep[] = [];
  for (const leg of legs) {
    for (const step of leg.steps) {
      const start = step.startLocation?.latLng;
      const end = step.endLocation?.latLng;
      if (!start || !end) continue;
      steps.push({
        instructionText: step.navigationInstruction?.instructions?.trim() || "Continue.",
        maneuver: step.navigationInstruction?.maneuver ?? null,
        distanceMeters: step.distanceMeters ?? 0,
        start,
        end,
      });
    }
  }
  return steps;
}

export function acceptGoogleRoute(
  candidate: GoogleRouteCandidate,
  options: {
    start: GeoPoint;
    handoff: GeoPoint;
    surveyedGeometry: GeoPoint[];
    maxCorridorDistanceM: number;
    maxEndpointSnapDistanceM: number;
  },
): GoogleRouteAcceptance {
  if (
    distanceMeters(candidate.snappedStart, options.start) >
    options.maxEndpointSnapDistanceM
  ) {
    return { accepted: false, reason: "Google snapped the start outside the surveyed area" };
  }
  if (
    distanceMeters(candidate.snappedEnd, options.handoff) >
    options.maxEndpointSnapDistanceM
  ) {
    return { accepted: false, reason: "Google snapped the endpoint away from the selected entrance" };
  }
  const outsideCorridor = candidate.geometry.find(
    (point) =>
      distanceToPolylineMeters(point, options.surveyedGeometry) >
      options.maxCorridorDistanceM,
  );
  if (outsideCorridor) {
    return { accepted: false, reason: "Google route leaves the surveyed pedestrian corridor" };
  }
  return { accepted: true, reason: null };
}

export function decodeGooglePolyline(encoded: string): GeoPoint[] {
  const points: GeoPoint[] = [];
  let latitude = 0;
  let longitude = 0;
  let index = 0;

  while (index < encoded.length) {
    const latitudeResult = decodePolylineValue(encoded, index);
    latitude += latitudeResult.delta;
    index = latitudeResult.nextIndex;
    if (index >= encoded.length) throw new Error("Google route polyline is truncated");
    const longitudeResult = decodePolylineValue(encoded, index);
    longitude += longitudeResult.delta;
    index = longitudeResult.nextIndex;
    points.push({
      latitude: latitude / 100_000,
      longitude: longitude / 100_000,
    });
  }
  return points;
}

function decodePolylineValue(
  encoded: string,
  startIndex: number,
): { delta: number; nextIndex: number } {
  let result = 0;
  let shift = 0;
  let index = startIndex;
  let byte: number;
  do {
    if (index >= encoded.length || shift > 30) {
      throw new Error("Google route polyline is malformed");
    }
    byte = encoded.charCodeAt(index) - 63;
    if (byte < 0 || byte > 63) throw new Error("Google route polyline is malformed");
    result |= (byte & 0x1f) << shift;
    shift += 5;
    index += 1;
  } while (byte >= 0x20);
  return {
    delta: result & 1 ? ~(result >> 1) : result >> 1,
    nextIndex: index,
  };
}

function latLngOf(point: GeoPoint): { latitude: number; longitude: number } {
  return { latitude: point.latitude, longitude: point.longitude };
}

function parseDurationSeconds(duration: string | undefined): number | null {
  if (!duration) return null;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(duration);
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? seconds : null;
}

function surveyedOutdoorGeometry(manifest: RouteManifest): GeoPoint[] {
  const points: GeoPoint[] = [];
  for (const segment of manifest.segments) {
    if (segment.environment !== "outdoor") break;
    for (const point of segment.polyline) {
      const previous = points.at(-1);
      if (
        !previous ||
        previous.latitude !== point.latitude ||
        previous.longitude !== point.longitude
      ) {
        points.push(point);
      }
    }
    if (segment.toAnchorId === manifest.handoffAnchorId) break;
  }
  if (points.length < 2) {
    throw new Error("Surveyed route has no usable outdoor geometry");
  }
  return points;
}
