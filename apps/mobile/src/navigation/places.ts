import type { GeoPoint, PlaceCandidate } from "@blind-maps/contracts";
import { distanceMeters } from "@blind-maps/navigation";
import { z } from "zod";

const SEARCH_TEXT_URL = "https://places.googleapis.com/v1/places:searchText";

export const PLACES_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
].join(",");

const MAX_LOCATION_BIAS_RADIUS_M = 50_000;

const searchTextResponseSchema = z.object({
  places: z
    .array(
      z.object({
        id: z.string().min(1),
        displayName: z.object({ text: z.string().min(1) }).optional(),
        formattedAddress: z.string().optional(),
        location: z
          .object({
            latitude: z.number().finite().min(-90).max(90),
            longitude: z.number().finite().min(-180).max(180),
          })
          .optional(),
      }),
    )
    .optional()
    .default([]),
});

export class PlacesRequestError extends Error {
  constructor(
    readonly kind: "timeout" | "api_error" | "not_configured",
    message: string,
  ) {
    super(message);
    this.name = "PlacesRequestError";
  }
}

export interface SearchPlacesOptions {
  apiKey: string | undefined;
  query: string;
  origin: GeoPoint;
  radiusM: number;
  regionCode?: string;
  timeoutMs: number;
  maxResults?: number;
  fetchImpl?: typeof fetch;
}

export async function searchPlaces(options: SearchPlacesOptions): Promise<PlaceCandidate[]> {
  if (!options.apiKey) {
    throw new PlacesRequestError("not_configured", "Google Places is not configured");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(SEARCH_TEXT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": options.apiKey,
        "X-Goog-FieldMask": PLACES_FIELD_MASK,
      },
      body: JSON.stringify({
        textQuery: options.query,
        languageCode: "en",
        ...(options.regionCode ? { regionCode: options.regionCode } : {}),
        maxResultCount: options.maxResults ?? 5,
        locationBias: {
          circle: {
            center: { latitude: options.origin.latitude, longitude: options.origin.longitude },
            radius: Math.min(Math.max(options.radiusM, 1), MAX_LOCATION_BIAS_RADIUS_M),
          },
        },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new PlacesRequestError("timeout", "Google Places request timed out");
    }
    throw new PlacesRequestError(
      "api_error",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new PlacesRequestError("api_error", `Google Places returned HTTP ${response.status}`);
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new PlacesRequestError("api_error", "Google Places returned invalid JSON");
  }

  const parsed = searchTextResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PlacesRequestError(
      "api_error",
      "Google Places response did not match the expected schema",
    );
  }

  const candidates: PlaceCandidate[] = [];
  for (const place of parsed.data.places) {
    if (!place.location || !place.displayName) continue;
    candidates.push({
      placeId: place.id,
      name: place.displayName.text,
      address: place.formattedAddress ?? "",
      position: { latitude: place.location.latitude, longitude: place.location.longitude },
    });
  }

  return candidates.sort(
    (left, right) =>
      distanceMeters(options.origin, left.position) -
      distanceMeters(options.origin, right.position),
  );
}

export function describePlace(candidate: PlaceCandidate, origin: GeoPoint): string {
  const meters = Math.round(distanceMeters(origin, candidate.position));
  const distance =
    meters >= 1000 ? `${(meters / 1000).toFixed(1)} kilometres` : `${Math.round(meters / 5) * 5} metres`;
  const street = firstAddressLine(candidate.address);
  return street
    ? `${candidate.name} on ${street}, about ${distance} away`
    : `${candidate.name}, about ${distance} away`;
}

function firstAddressLine(address: string): string | null {
  const line = address.split(",")[0]?.trim();
  return line ? line : null;
}
