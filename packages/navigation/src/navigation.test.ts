import type { RouteManifest, SceneObservation } from "@blind-maps/contracts";
import { describe, expect, it } from "vitest";

import {
  createNavigationState,
  loadRouteManifest,
  markArrivalAnnounced,
  reduceNavigation,
  requireAvailableRoute,
  type NavigationLocation,
  type NavigationState,
  type RouteModule,
} from "./index.js";

const route: RouteManifest = {
  id: "usf-library",
  version: 1,
  surveyedAt: "2026-09-19",
  destinationName: "USF Tampa Library",
  startAnchorId: "start",
  handoffAnchorId: "entrance",
  arrivalAnchorId: "vestibule",
  supportedStartRadiusM: 30,
  anchors: [
    {
      id: "start",
      kind: "start",
      position: { latitude: 28, longitude: -82 },
      expectedVisibleText: [],
      visualDescription: "Surveyed start",
      referenceImagePaths: [],
    },
    {
      id: "landmark",
      kind: "outdoor_landmark",
      position: { latitude: 28.0001, longitude: -82 },
      expectedVisibleText: [],
      visualDescription: "Surveyed outdoor landmark",
      referenceImagePaths: [],
    },
    {
      id: "entrance",
      kind: "entrance",
      position: { latitude: 28.0002, longitude: -82 },
      expectedVisibleText: ["LIBRARY"],
      visualDescription: "Selected library entrance",
      referenceImagePaths: ["entrance.jpg"],
    },
    {
      id: "vestibule",
      kind: "vestibule",
      position: null,
      expectedVisibleText: [],
      visualDescription: "Selected entrance vestibule",
      referenceImagePaths: ["vestibule.jpg"],
    },
  ],
  segments: [
    {
      id: "to-landmark",
      fromAnchorId: "start",
      toAnchorId: "landmark",
      environment: "outdoor",
      polyline: [
        { latitude: 28, longitude: -82 },
        { latitude: 28.0001, longitude: -82 },
      ],
      instructionId: "walk-to-landmark",
      instructionText: "Continue to the surveyed landmark.",
      requiresVisualConfirmation: false,
      requiresUserConfirmation: false,
    },
    {
      id: "to-entrance",
      fromAnchorId: "landmark",
      toAnchorId: "entrance",
      environment: "outdoor",
      polyline: [
        { latitude: 28.0001, longitude: -82 },
        { latitude: 28.0002, longitude: -82 },
      ],
      instructionId: "walk-to-entrance",
      instructionText: "Continue to the selected entrance.",
      requiresVisualConfirmation: true,
      requiresUserConfirmation: false,
    },
    {
      id: "enter-vestibule",
      fromAnchorId: "entrance",
      toAnchorId: "vestibule",
      environment: "indoor",
      polyline: [],
      instructionId: "enter-vestibule",
      instructionText: "Enter the vestibule and stop.",
      requiresVisualConfirmation: true,
      requiresUserConfirmation: true,
    },
  ],
};

describe("route manifest", () => {
  it("loads a complete surveyed route", () => {
    expect(loadRouteManifest(route)).toEqual({ available: true, manifest: route });
  });

  it("rejects an incomplete route instead of enabling guidance", () => {
    const result = loadRouteManifest({ ...route, anchors: [] });
    expect(result.available).toBe(false);
  });

  it("prevents navigation when no surveyed route is available", () => {
    const module: RouteModule = { routeId: null, routeRevision: 0 };
    expect(() => requireAvailableRoute(module)).toThrow(
      "No surveyed route is available",
    );
  });
});

describe("navigation reducer", () => {
  it("rejects a start outside the supported area", () => {
    let state = requestDestination(
      location(createNavigationState(route), 28.01, -82),
    );
    state = reduceNavigation(
      state,
      { type: "CONFIRM_DESTINATION", confirmedAtMonotonicMs: 1_000 },
      route,
    );
    expect(state.phase).toBe("destination_confirmation");
    expect(state.status).toContain("outside the supported start area");
  });

  it("waits for usable GPS accuracy and phone alignment", () => {
    let state = location(createNavigationState(route), 28, -82, 30);
    state = requestDestination(state);
    state = reduceNavigation(
      state,
      { type: "CONFIRM_DESTINATION", confirmedAtMonotonicMs: 1_000 },
      route,
    );
    expect(state.status).toContain("accurate location");

    state = location(state, 28, -82, 5);
    state = reduceNavigation(
      state,
      { type: "CONFIRM_DESTINATION", confirmedAtMonotonicMs: 1_000 },
      route,
    );
    expect(state.phase).toBe("alignment");
    state = reduceNavigation(state, { type: "ALIGNMENT", usable: false }, route);
    expect(state.phase).toBe("alignment");
    state = reduceNavigation(state, { type: "ALIGNMENT", usable: true }, route);
    expect(state.phase).toBe("alignment");
    state = reduceNavigation(
      state,
      { type: "ORIENTATION", trueHeadingDeg: null, accuracyLevel: 0 },
      route,
    );
    expect(state.status).toContain("reliable phone heading");
    state = reduceNavigation(
      state,
      { type: "ORIENTATION", trueHeadingDeg: 0, accuracyLevel: 3 },
      route,
    );
    expect(state.phase).toBe("outdoor");
  });

  it("does not start from an old location fix", () => {
    let state = requestDestination(
      location(createNavigationState(route), 28, -82),
    );
    state = reduceNavigation(
      state,
      { type: "CONFIRM_DESTINATION", confirmedAtMonotonicMs: 6_000 },
      route,
    );
    expect(state.phase).toBe("destination_confirmation");
    expect(state.status).toContain("fresh location");
  });

  it("uses three consistent samples and hysteresis before advancing", () => {
    let state = beginOutdoor();
    state = location(state, 28.0001, -82);
    state = location(state, 28.00016, -82);
    expect(state.currentSegmentIndex).toBe(0);
    state = location(state, 28.0001, -82);
    state = location(state, 28.0001, -82);
    state = location(state, 28.0001, -82);
    expect(state.currentSegmentIndex).toBe(1);
    expect(state.lastInstruction).toBe("Continue to the selected entrance.");
  });

  it("pauses after sustained deviation and keeps the route phase", () => {
    let state = beginOutdoor();
    state = location(state, 28, -82.001);
    state = location(state, 28, -82.001);
    state = location(state, 28, -82.001);
    expect(state.paused).toBe(true);
    expect(state.phase).toBe("outdoor");
    expect(state.status).toContain("left the verified route");
  });

  it("keeps the same segment across a manual pause and resume", () => {
    let state = advanceToEntranceSegment();
    const segment = state.currentSegmentIndex;
    state = reduceNavigation(state, { type: "PAUSE", sessionEpoch: 1 }, route);
    state = reduceNavigation(state, { type: "RESUME", sessionEpoch: 2 }, route);
    expect(state.paused).toBe(false);
    expect(state.currentSegmentIndex).toBe(segment);
    expect(state.sessionEpoch).toBe(2);
  });

  it("rejects stale observations and observations from an old revision", () => {
    const atEntrance = reachEntrance();
    const observation = sceneObservation("entrance", 1_000);
    const oldRevision = reduceNavigation(
      atEntrance,
      {
        type: "OBSERVATION",
        observation,
        routeRevision: atEntrance.routeRevision - 1,
        sessionEpoch: atEntrance.sessionEpoch,
        receivedAtMonotonicMs: 1_500,
      },
      route,
    );
    expect(oldRevision.phase).toBe("entrance_search");

    const stale = reduceNavigation(
      atEntrance,
      {
        type: "OBSERVATION",
        observation,
        routeRevision: atEntrance.routeRevision,
        sessionEpoch: atEntrance.sessionEpoch,
        receivedAtMonotonicMs: 5_000,
      },
      route,
    );
    expect(stale.phase).toBe("entrance_search");
    expect(stale.status).toContain("too old");
  });

  it("requires entrance evidence, vestibule evidence, and user confirmation", () => {
    let state = reachEntrance();
    state = acceptObservation(state, sceneObservation("entrance", 1_000), 1_500);
    expect(state.phase).toBe("vestibule_confirmation");

    state = reduceNavigation(
      state,
      { type: "CONFIRM_INSIDE", confirmedAtMonotonicMs: 2_000 },
      route,
    );
    expect(state.phase).toBe("vestibule_confirmation");
    expect(state.status).toContain("current view");

    state = acceptObservation(state, sceneObservation("vestibule", 2_000), 2_500);
    expect(state.phase).toBe("vestibule_confirmation");
    state = reduceNavigation(
      state,
      { type: "CONFIRM_INSIDE", confirmedAtMonotonicMs: 2_800 },
      route,
    );
    expect(state.phase).toBe("arrived");
  });

  it("marks the arrival announcement once", () => {
    let state = reachEntrance();
    state = acceptObservation(state, sceneObservation("entrance", 1_000), 1_500);
    state = acceptObservation(state, sceneObservation("vestibule", 2_000), 2_500);
    state = reduceNavigation(
      state,
      { type: "CONFIRM_INSIDE", confirmedAtMonotonicMs: 2_800 },
      route,
    );
    const announced = markArrivalAnnounced(state);
    expect(announced.arrivalAnnounced).toBe(true);
    expect(markArrivalAnnounced(announced)).toBe(announced);
  });

  it("does not arrive from an old vestibule observation", () => {
    let state = reachEntrance();
    state = acceptObservation(state, sceneObservation("entrance", 1_000), 1_500);
    state = acceptObservation(state, sceneObservation("vestibule", 2_000), 2_500);
    state = reduceNavigation(
      state,
      { type: "CONFIRM_INSIDE", confirmedAtMonotonicMs: 6_000 },
      route,
    );
    expect(state.phase).toBe("vestibule_confirmation");
    expect(state.vestibuleEvidenceAnalysisId).toBeNull();
    expect(state.status).toContain("too old");
  });
});

function beginOutdoor(): NavigationState {
  let state = location(createNavigationState(route), 28, -82);
  state = requestDestination(state);
  state = reduceNavigation(
    state,
    { type: "CONFIRM_DESTINATION", confirmedAtMonotonicMs: 1_000 },
    route,
  );
  state = reduceNavigation(
    state,
    { type: "ORIENTATION", trueHeadingDeg: 0, accuracyLevel: 3 },
    route,
  );
  return reduceNavigation(state, { type: "ALIGNMENT", usable: true }, route);
}

function advanceToEntranceSegment(): NavigationState {
  let state = beginOutdoor();
  state = location(state, 28.0001, -82);
  state = location(state, 28.0001, -82);
  return location(state, 28.0001, -82);
}

function reachEntrance(): NavigationState {
  let state = advanceToEntranceSegment();
  state = location(state, 28.0002, -82);
  state = location(state, 28.0002, -82);
  return location(state, 28.0002, -82);
}

function requestDestination(state: NavigationState): NavigationState {
  return reduceNavigation(
    state,
    { type: "REQUEST_DESTINATION", destinationId: route.id },
    route,
  );
}

function location(
  state: NavigationState,
  latitude: number,
  longitude: number,
  accuracyM = 5,
): NavigationState {
  const sample: NavigationLocation = {
    latitude,
    longitude,
    accuracyM,
    capturedAtMonotonicMs: 500,
    travelHeadingDeg: 0,
  };
  return reduceNavigation(state, { type: "LOCATION", sample }, route);
}

function sceneObservation(anchorId: string, capturedAt: number): SceneObservation {
  return {
    analysisId: `analysis-${anchorId}`,
    sourceFrameId: "frame-1",
    sourceCapturedAtMonotonicMs: capturedAt,
    visibleText: [],
    candidateAnchorIds: [anchorId],
    doorPositionInImage: "center",
    viewUsable: true,
    requiresAnotherView: false,
    description: "Test observation",
  };
}

function acceptObservation(
  state: NavigationState,
  observation: SceneObservation,
  receivedAtMonotonicMs: number,
): NavigationState {
  return reduceNavigation(
    state,
    {
      type: "OBSERVATION",
      observation,
      routeRevision: state.routeRevision,
      sessionEpoch: state.sessionEpoch,
      receivedAtMonotonicMs,
    },
    route,
  );
}
