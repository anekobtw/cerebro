import type {
  NavigationPhase,
  NavigationProgress,
  RouteManifest,
  SceneObservation,
  SessionOutdoorRoute,
} from "@cerebro/contracts";

import {
  bearingDegrees,
  distanceMeters,
  distanceToPolylineMeters,
  headingDifferenceDegrees,
} from "./geometry.js";

export interface NavigationLocation {
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  capturedAtMonotonicMs: number;
  travelHeadingDeg: number | null;
}

export interface NavigationConfig {
  maxHorizontalAccuracyM: number;
  consistentSamplesRequired: number;
  waypointEnterRadiusM: number;
  waypointExitRadiusM: number;
  corridorRadiusM: number;
  deviationSamplesRequired: number;
  maxObservationAgeMs: number;
  maxLocationAgeMs: number;
  maxAlignmentHeadingDifferenceDeg: number;
}

export const DEFAULT_NAVIGATION_CONFIG: NavigationConfig = {
  maxHorizontalAccuracyM: 15,
  consistentSamplesRequired: 3,
  waypointEnterRadiusM: 10,
  waypointExitRadiusM: 16,
  corridorRadiusM: 20,
  deviationSamplesRequired: 3,
  maxObservationAgeMs: 3_000,
  maxLocationAgeMs: 5_000,
  maxAlignmentHeadingDifferenceDeg: 35,
};

export interface NavigationState {
  routeId: string;
  routeVersion: number;
  phase: NavigationPhase;
  paused: boolean;
  currentSegmentIndex: number | null;
  routeRevision: number;
  sessionEpoch: number;
  destinationRequested: boolean;
  alignmentReady: boolean;
  viewAlignmentReady: boolean;
  headingAlignmentReady: boolean;
  consistentProgressSamples: number;
  deviationSamples: number;
  pendingVisualAnchorId: string | null;
  entranceEvidenceAnalysisId: string | null;
  vestibuleEvidenceAnalysisId: string | null;
  vestibuleEvidenceCapturedAtMonotonicMs: number | null;
  userConfirmedInside: boolean;
  arrivalAnnounced: boolean;
  outdoorRoute: SessionOutdoorRoute | null;
  lastLocation: NavigationLocation | null;
  lastInstruction: string | null;
  status: string;
}

export type NavigationEvent =
  | { type: "LOCATION"; sample: NavigationLocation }
  | { type: "REQUEST_DESTINATION"; destinationId: string }
  | { type: "CONFIRM_DESTINATION"; confirmedAtMonotonicMs: number }
  | { type: "ALIGNMENT"; usable: boolean }
  | {
      type: "ORIENTATION";
      trueHeadingDeg: number | null;
      accuracyLevel: number;
    }
  | {
      type: "OBSERVATION";
      observation: SceneObservation;
      routeRevision: number;
      sessionEpoch: number;
      receivedAtMonotonicMs: number;
    }
  | { type: "CONFIRM_INSIDE"; confirmedAtMonotonicMs: number }
  | { type: "SET_OUTDOOR_ROUTE"; route: SessionOutdoorRoute }
  | { type: "SESSION_EPOCH"; sessionEpoch: number }
  | { type: "PAUSE"; sessionEpoch: number }
  | { type: "RESUME"; sessionEpoch: number }
  | { type: "RESET"; sessionEpoch: number };

export function createNavigationState(
  manifest: RouteManifest,
  sessionEpoch = 0,
): NavigationState {
  return {
    routeId: manifest.id,
    routeVersion: manifest.version,
    phase: "ready",
    paused: false,
    currentSegmentIndex: null,
    routeRevision: 0,
    sessionEpoch,
    destinationRequested: false,
    alignmentReady: false,
    viewAlignmentReady: false,
    headingAlignmentReady: false,
    consistentProgressSamples: 0,
    deviationSamples: 0,
    pendingVisualAnchorId: null,
    entranceEvidenceAnalysisId: null,
    vestibuleEvidenceAnalysisId: null,
    vestibuleEvidenceCapturedAtMonotonicMs: null,
    userConfirmedInside: false,
    arrivalAnnounced: false,
    outdoorRoute: null,
    lastLocation: null,
    lastInstruction: null,
    status: `Ready for ${manifest.destinationName}.`,
  };
}

export function reduceNavigation(
  state: NavigationState,
  event: NavigationEvent,
  manifest: RouteManifest,
  config: NavigationConfig = DEFAULT_NAVIGATION_CONFIG,
): NavigationState {
  if (state.routeId !== manifest.id || state.routeVersion !== manifest.version) {
    throw new Error("Navigation state does not match the route manifest");
  }

  switch (event.type) {
    case "LOCATION":
      return reduceLocation(state, event.sample, manifest, config);
    case "REQUEST_DESTINATION":
      if (state.phase !== "ready") return state;
      if (event.destinationId !== manifest.id) {
        return {
          ...state,
          status: `This build supports only ${manifest.destinationName}.`,
        };
      }
      return changed(state, {
        destinationRequested: true,
        phase: "destination_confirmation",
        status: `Confirm destination: ${manifest.destinationName}.`,
      });
    case "CONFIRM_DESTINATION":
      return confirmDestination(
        state,
        event.confirmedAtMonotonicMs,
        manifest,
        config,
      );
    case "ALIGNMENT":
      if (state.phase !== "alignment" || state.paused) return state;
      if (!event.usable) {
        return { ...state, status: "Point the phone ahead while standing still." };
      }
      return alignmentResult(
        { ...state, viewAlignmentReady: true },
        manifest,
      );
    case "ORIENTATION":
      return reduceOrientation(state, event, manifest, config);
    case "OBSERVATION":
      return reduceObservation(state, event, manifest, config);
    case "CONFIRM_INSIDE":
      return confirmInside(
        state,
        event.confirmedAtMonotonicMs,
        manifest,
        config,
      );
    case "SET_OUTDOOR_ROUTE":
      if (
        event.route.surveyedRouteId !== manifest.id ||
        event.route.surveyedRouteVersion !== manifest.version ||
        event.route.handoffAnchorId !== manifest.handoffAnchorId
      ) {
        throw new Error("Outdoor route does not match the surveyed manifest");
      }
      return changed(state, { outdoorRoute: event.route });
    case "SESSION_EPOCH":
      if (event.sessionEpoch === state.sessionEpoch) return state;
      return { ...state, sessionEpoch: event.sessionEpoch };
    case "PAUSE":
      if (state.phase === "arrived") return state;
      if (state.paused) {
        return event.sessionEpoch === state.sessionEpoch
          ? state
          : { ...state, sessionEpoch: event.sessionEpoch };
      }
      return changed(state, {
        paused: true,
        sessionEpoch: event.sessionEpoch,
        consistentProgressSamples: 0,
        deviationSamples: 0,
        status: "Navigation paused.",
      });
    case "RESUME":
      if (!state.paused || state.phase === "arrived") return state;
      return changed(state, {
        paused: false,
        sessionEpoch: event.sessionEpoch,
        status: state.lastInstruction ?? "Navigation resumed.",
      });
    case "RESET":
      return createNavigationState(manifest, event.sessionEpoch);
  }
}

export function navigationProgress(state: NavigationState, manifest: RouteManifest): NavigationProgress {
  const segment =
    state.currentSegmentIndex === null
      ? null
      : (manifest.segments[state.currentSegmentIndex] ?? null);
  return {
    routeId: state.routeId,
    phase: state.phase,
    paused: state.paused,
    segmentId: segment?.id ?? null,
    instructionId: segment?.instructionId ?? null,
    routeRevision: state.routeRevision,
  };
}

export function markArrivalAnnounced(state: NavigationState): NavigationState {
  if (state.phase !== "arrived" || state.arrivalAnnounced) return state;
  return { ...state, arrivalAnnounced: true };
}

function reduceOrientation(
  state: NavigationState,
  event: Extract<NavigationEvent, { type: "ORIENTATION" }>,
  manifest: RouteManifest,
  config: NavigationConfig,
): NavigationState {
  if (state.phase !== "alignment" || state.paused) return state;
  const firstPolyline = manifest.segments[0]?.polyline ?? [];
  if (
    event.trueHeadingDeg === null ||
    event.accuracyLevel < 2 ||
    firstPolyline.length < 2
  ) {
    return {
      ...state,
      headingAlignmentReady: false,
      status: "Waiting for a reliable phone heading.",
    };
  }
  const routeHeading = bearingDegrees(firstPolyline[0], firstPolyline[1]);
  const aligned =
    headingDifferenceDegrees(event.trueHeadingDeg, routeHeading) <=
    config.maxAlignmentHeadingDifferenceDeg;
  if (!aligned) {
    return {
      ...state,
      headingAlignmentReady: false,
      status: "Turn with the phone until it points along the surveyed route.",
    };
  }
  return alignmentResult(
    { ...state, headingAlignmentReady: true },
    manifest,
  );
}

function alignmentResult(
  state: NavigationState,
  manifest: RouteManifest,
): NavigationState {
  if (!state.viewAlignmentReady || !state.headingAlignmentReady) {
    return {
      ...state,
      status: state.viewAlignmentReady
        ? "The camera view is usable. Point the phone along the surveyed route."
        : "The phone heading is aligned. Hold the camera steady and point it ahead.",
    };
  }
  return changed(state, {
    alignmentReady: true,
    phase: "outdoor",
    currentSegmentIndex: 0,
    lastInstruction: manifest.segments[0].instructionText,
    status: manifest.segments[0].instructionText,
  });
}

function confirmDestination(
  state: NavigationState,
  confirmedAtMonotonicMs: number,
  manifest: RouteManifest,
  config: NavigationConfig,
): NavigationState {
  if (state.phase !== "destination_confirmation" || !state.destinationRequested) return state;
  const location = state.lastLocation;
  if (!location || !hasUsableAccuracy(location, config)) {
    return {
      ...state,
      status: "Waiting for an accurate location before guidance starts.",
    };
  }
  const locationAgeMs =
    confirmedAtMonotonicMs - location.capturedAtMonotonicMs;
  if (locationAgeMs < 0 || locationAgeMs > config.maxLocationAgeMs) {
    return {
      ...state,
      status: "Waiting for a fresh location before guidance starts.",
    };
  }
  const start = anchorPosition(manifest, manifest.startAnchorId);
  const startDistanceM = distanceMeters(location, start);
  if (startDistanceM > manifest.supportedStartRadiusM) {
    return {
      ...state,
      status: `You are outside the supported start area by ${Math.round(startDistanceM)} meters.`,
    };
  }
  return changed(state, {
    phase: "alignment",
    status: "Point the phone ahead while standing still.",
  });
}

function reduceLocation(
  state: NavigationState,
  sample: NavigationLocation,
  manifest: RouteManifest,
  config: NavigationConfig,
): NavigationState {
  const withLocation = { ...state, lastLocation: sample };
  if (state.paused || state.phase !== "outdoor" || state.currentSegmentIndex === null) {
    return withLocation;
  }
  if (!hasUsableAccuracy(sample, config)) {
    return {
      ...withLocation,
      consistentProgressSamples: 0,
      status: "Location accuracy is too low. Stop and wait for a better GPS fix.",
    };
  }

  const segment = manifest.segments[state.currentSegmentIndex];
  if (!segment || segment.environment !== "outdoor") return withLocation;
  const nextSegment = manifest.segments[state.currentSegmentIndex + 1];
  const corridorDistanceM = state.outdoorRoute
    ? distanceToPolylineMeters(sample, state.outdoorRoute.outdoorGeometry)
    : Math.min(
        distanceToPolylineMeters(sample, segment.polyline),
        nextSegment?.environment === "outdoor"
          ? distanceToPolylineMeters(sample, nextSegment.polyline)
          : Number.POSITIVE_INFINITY,
      );
  const deviationSamples =
    corridorDistanceM > config.corridorRadiusM
      ? state.deviationSamples + 1
      : 0;
  if (deviationSamples >= config.deviationSamplesRequired) {
    return changed(withLocation, {
      paused: true,
      deviationSamples,
      consistentProgressSamples: 0,
      status: "You have left the verified route. Stop. Guidance is paused.",
    });
  }

  const nextAnchor = anchorPosition(manifest, segment.toAnchorId);
  const distanceToNextM = distanceMeters(sample, nextAnchor);
  const withinWaypoint = distanceToNextM <= config.waypointEnterRadiusM;
  const consistentProgressSamples = withinWaypoint
    ? state.consistentProgressSamples + 1
    : distanceToNextM >= config.waypointExitRadiusM
      ? 0
      : state.consistentProgressSamples;

  if (consistentProgressSamples < config.consistentSamplesRequired) {
    return {
      ...withLocation,
      deviationSamples,
      consistentProgressSamples,
    };
  }

  if (segment.requiresVisualConfirmation) {
    return changed(withLocation, {
      deviationSamples,
      consistentProgressSamples: 0,
      pendingVisualAnchorId: segment.toAnchorId,
      phase:
        segment.toAnchorId === manifest.handoffAnchorId
          ? "entrance_search"
          : state.phase,
      status:
        segment.toAnchorId === manifest.handoffAnchorId
          ? "Near the surveyed entrance. Stop while I check the camera view."
          : "At the next landmark. Stop while I check the camera view.",
    });
  }
  return advanceSegment(withLocation, manifest);
}

function reduceObservation(
  state: NavigationState,
  event: Extract<NavigationEvent, { type: "OBSERVATION" }>,
  manifest: RouteManifest,
  config: NavigationConfig,
): NavigationState {
  if (state.paused || state.phase === "arrived") return state;
  if (
    event.routeRevision !== state.routeRevision ||
    event.sessionEpoch !== state.sessionEpoch
  ) {
    return { ...state, status: "Ignored a scene result from an older route state." };
  }
  const ageMs =
    event.receivedAtMonotonicMs -
    event.observation.sourceCapturedAtMonotonicMs;
  if (ageMs < 0 || ageMs > config.maxObservationAgeMs) {
    return { ...state, status: "That camera view is too old. Please hold the phone up again." };
  }
  if (!event.observation.viewUsable || event.observation.requiresAnotherView) {
    return { ...state, status: "I need another steady view before using that observation." };
  }
  if (state.phase === "alignment") {
    return reduceNavigation(
      state,
      { type: "ALIGNMENT", usable: true },
      manifest,
      config,
    );
  }

  const expectedAnchorId =
    state.pendingVisualAnchorId ??
    (state.phase === "vestibule_confirmation" ? manifest.arrivalAnchorId : null);
  if (
    expectedAnchorId === null ||
    !event.observation.candidateAnchorIds.includes(expectedAnchorId)
  ) {
    return {
      ...state,
      status: "The current view does not match the expected route anchor.",
    };
  }

  const anchor = manifest.anchors.find((candidate) => candidate.id === expectedAnchorId);
  if (anchor?.kind === "entrance") {
    const nextIndex = Math.min(
      (state.currentSegmentIndex ?? 0) + 1,
      manifest.segments.length - 1,
    );
    const instruction = manifest.segments[nextIndex]?.instructionText ?? null;
    return changed(state, {
      currentSegmentIndex: nextIndex,
      pendingVisualAnchorId: null,
      entranceEvidenceAnalysisId: event.observation.analysisId,
      phase: "vestibule_confirmation",
      lastInstruction: instruction,
      status: instruction ?? "Enter the vestibule, then tell me when you are inside.",
    });
  }
  if (anchor?.kind === "vestibule") {
    return changed(state, {
      pendingVisualAnchorId: null,
      vestibuleEvidenceAnalysisId: event.observation.analysisId,
      vestibuleEvidenceCapturedAtMonotonicMs:
        event.observation.sourceCapturedAtMonotonicMs,
      status: "The view matches the surveyed vestibule. Are you inside?",
    });
  }
  return advanceSegment(
    { ...state, pendingVisualAnchorId: null },
    manifest,
  );
}

function confirmInside(
  state: NavigationState,
  confirmedAtMonotonicMs: number,
  manifest: RouteManifest,
  config: NavigationConfig,
): NavigationState {
  if (state.phase !== "vestibule_confirmation") return state;
  if (!state.entranceEvidenceAnalysisId) {
    return { ...state, status: "I have not verified the selected entrance yet." };
  }
  if (!state.vestibuleEvidenceAnalysisId) {
    return { ...state, status: "I need a current view of the surveyed vestibule first." };
  }
  if (
    state.vestibuleEvidenceCapturedAtMonotonicMs === null ||
    confirmedAtMonotonicMs < state.vestibuleEvidenceCapturedAtMonotonicMs ||
    confirmedAtMonotonicMs -
      state.vestibuleEvidenceCapturedAtMonotonicMs >
      config.maxObservationAgeMs
  ) {
    return {
      ...state,
      vestibuleEvidenceAnalysisId: null,
      vestibuleEvidenceCapturedAtMonotonicMs: null,
      status: "The vestibule view is too old. Please hold the phone up again.",
    };
  }
  return changed(state, {
    userConfirmedInside: true,
    phase: "arrived",
    currentSegmentIndex: manifest.segments.length - 1,
    lastInstruction: "You have arrived inside the library vestibule.",
    status: "You have arrived inside the library vestibule.",
  });
}

function advanceSegment(
  state: NavigationState,
  manifest: RouteManifest,
): NavigationState {
  if (state.currentSegmentIndex === null) return state;
  const nextIndex = state.currentSegmentIndex + 1;
  const next = manifest.segments[nextIndex];
  if (!next) return state;
  return changed(state, {
    currentSegmentIndex: nextIndex,
    consistentProgressSamples: 0,
    deviationSamples: 0,
    lastInstruction: next.instructionText,
    status: next.instructionText,
  });
}

function changed(
  state: NavigationState,
  patch: Partial<NavigationState>,
): NavigationState {
  return {
    ...state,
    ...patch,
    routeRevision: state.routeRevision + 1,
  };
}

function hasUsableAccuracy(
  sample: NavigationLocation,
  config: NavigationConfig,
): boolean {
  return (
    sample.accuracyM !== null &&
    Number.isFinite(sample.accuracyM) &&
    sample.accuracyM <= config.maxHorizontalAccuracyM
  );
}

function anchorPosition(manifest: RouteManifest, anchorId: string) {
  const anchor = manifest.anchors.find((candidate) => candidate.id === anchorId);
  if (!anchor?.position) {
    throw new Error(`Route anchor ${anchorId} has no outdoor position`);
  }
  return anchor.position;
}
