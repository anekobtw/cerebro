import type { RouteManifest } from "@blind-maps/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  acceptGoogleRoute,
  decodeGooglePolyline,
  requestGoogleWalkingRoute,
  selectOutdoorRoute,
} from "./google-routes";

const encodedPolyline = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";
const geometry = [
  { latitude: 38.5, longitude: -120.2 },
  { latitude: 40.7, longitude: -120.95 },
  { latitude: 43.252, longitude: -126.453 },
];

const manifest: RouteManifest = {
  id: "test-route",
  version: 1,
  surveyedAt: "2026-09-19",
  destinationName: "Test destination",
  startAnchorId: "start",
  handoffAnchorId: "entrance",
  arrivalAnchorId: "vestibule",
  supportedStartRadiusM: 20,
  anchors: [
    {
      id: "start",
      kind: "start",
      position: geometry[0],
      expectedVisibleText: [],
      visualDescription: "Start",
      referenceImagePaths: [],
    },
    {
      id: "entrance",
      kind: "entrance",
      position: geometry[2],
      expectedVisibleText: [],
      visualDescription: "Entrance",
      referenceImagePaths: [],
    },
    {
      id: "vestibule",
      kind: "vestibule",
      position: null,
      expectedVisibleText: [],
      visualDescription: "Vestibule",
      referenceImagePaths: [],
    },
  ],
  segments: [
    {
      id: "outdoor",
      fromAnchorId: "start",
      toAnchorId: "entrance",
      environment: "outdoor",
      polyline: geometry,
      instructionId: "outdoor",
      instructionText: "Follow the route.",
      requiresVisualConfirmation: true,
      requiresUserConfirmation: false,
    },
    {
      id: "inside",
      fromAnchorId: "entrance",
      toAnchorId: "vestibule",
      environment: "indoor",
      polyline: [],
      instructionId: "inside",
      instructionText: "Enter the vestibule.",
      requiresVisualConfirmation: true,
      requiresUserConfirmation: true,
    },
  ],
};

describe("Google Routes adapter", () => {
  it("decodes an encoded Google polyline", () => {
    expect(decodeGooglePolyline(encodedPolyline)).toEqual(geometry);
    expect(() => decodeGooglePolyline("_")).toThrow();
  });

  it("sends one walking request with the required field mask", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedInit = init;
        return new Response(
        JSON.stringify({
          routes: [
            {
              distanceMeters: 123,
              duration: "45.5s",
              polyline: { encodedPolyline },
              warnings: ["Walking routes are beta."],
              legs: [],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    const candidate = await requestGoogleWalkingRoute({
      apiKey: "secret-key",
      origin: geometry[0],
      destination: geometry[2],
      timeoutMs: 500,
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(candidate.durationSeconds).toBe(45.5);
    expect(candidate.geometry).toEqual(geometry);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(JSON.parse(String(capturedInit?.body))).toMatchObject({
      travelMode: "WALK",
      computeAlternativeRoutes: false,
    });
    expect(new Headers(capturedInit?.headers).get("X-Goog-FieldMask")).toContain(
      "routes.polyline.encodedPolyline",
    );
  });

  it("uses the surveyed route without making a request when disabled", async () => {
    const fetchImpl = vi.fn();
    const selected = await selectOutdoorRoute({
      enabled: false,
      apiKey: "unused",
      manifest,
      start: geometry[0],
      timeoutMs: 500,
      fetchImpl,
    });
    expect(selected.route.source).toBe("surveyed");
    expect(selected.route.fallbackReason).toBe("disabled");
    expect(selected.requestCount).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("falls back after an API error and records one request", async () => {
    const selected = await selectOutdoorRoute({
      enabled: true,
      apiKey: "secret-key",
      manifest,
      start: geometry[0],
      timeoutMs: 500,
      fetchImpl: vi.fn(async () => new Response("quota", { status: 429 })),
    });
    expect(selected.route.source).toBe("surveyed");
    expect(selected.route.fallbackReason).toBe("api_error");
    expect(selected.requestCount).toBe(1);
    expect(selected.rejectionReason).toBe("Google Routes returned HTTP 429");
  });

  it("rejects a route that leaves the surveyed corridor", () => {
    const acceptance = acceptGoogleRoute(
      {
        geometry: [geometry[0], { latitude: 0, longitude: 0 }, geometry[2]],
        distanceMeters: 10,
        durationSeconds: 10,
        warnings: [],
        snappedStart: geometry[0],
        snappedEnd: geometry[2],
      },
      {
        start: geometry[0],
        handoff: geometry[2],
        surveyedGeometry: geometry,
        maxCorridorDistanceM: 20,
        maxEndpointSnapDistanceM: 15,
      },
    );
    expect(acceptance).toEqual({
      accepted: false,
      reason: "Google route leaves the surveyed pedestrian corridor",
    });
  });

  it("rejects an endpoint snapped away from the selected entrance", () => {
    const acceptance = acceptGoogleRoute(
      {
        geometry,
        distanceMeters: 10,
        durationSeconds: 10,
        warnings: [],
        snappedStart: geometry[0],
        snappedEnd: geometry[1],
      },
      {
        start: geometry[0],
        handoff: geometry[2],
        surveyedGeometry: geometry,
        maxCorridorDistanceM: 20,
        maxEndpointSnapDistanceM: 15,
      },
    );
    expect(acceptance.accepted).toBe(false);
    expect(acceptance.reason).toContain("selected entrance");
  });

  it("uses the surveyed fallback when the request times out", async () => {
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );
    const selected = await selectOutdoorRoute({
      enabled: true,
      apiKey: "secret-key",
      manifest,
      start: geometry[0],
      timeoutMs: 1,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(selected.route.source).toBe("surveyed");
    expect(selected.route.fallbackReason).toBe("timeout");
    expect(selected.requestCount).toBe(1);
  });
});
