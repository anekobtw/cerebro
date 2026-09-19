import type {
  DynamicRoute,
  GeoPoint,
  NavigationPhase,
} from "@blind-maps/contracts";

import {
  bearingDegrees,
  distanceMeters,
  distanceToPolylineMeters,
} from "./geometry.js";

export interface DynamicGuidanceConfig {
  arrivalRadiusM: number;
  stepAdvanceRadiusM: number;
  turnWarningRadiusM: number;
  offRouteRadiusM: number;
  offRouteSamplesRequired: number;
  maxHorizontalAccuracyM: number;
}

export const DEFAULT_DYNAMIC_GUIDANCE_CONFIG: DynamicGuidanceConfig = {
  arrivalRadiusM: 30,
  stepAdvanceRadiusM: 12,
  turnWarningRadiusM: 25,
  offRouteRadiusM: 30,
  offRouteSamplesRequired: 4,
  maxHorizontalAccuracyM: 25,
};

export interface GuidanceLocation {
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  capturedAtMonotonicMs: number;
  travelHeadingDeg: number | null;
}

export interface DynamicGuidanceState {
  phase: NavigationPhase;
  stepIndex: number;
  announcedStepIndex: number | null;
  warnedStepIndex: number | null;
  offRouteSamples: number;
  offRouteDistanceM: number | null;
  distanceToDestinationM: number | null;
  distanceToStepEndM: number | null;
  lastInstruction: string | null;
  usableSamples: number;
  skippedSamples: number;
}

export interface DynamicGuidanceUpdate {
  state: DynamicGuidanceState;
  announcement: string | null;
  offRoute: boolean;
}

export function createDynamicGuidanceState(): DynamicGuidanceState {
  return {
    phase: "outdoor",
    stepIndex: 0,
    announcedStepIndex: null,
    warnedStepIndex: null,
    offRouteSamples: 0,
    offRouteDistanceM: null,
    distanceToDestinationM: null,
    distanceToStepEndM: null,
    lastInstruction: null,
    usableSamples: 0,
    skippedSamples: 0,
  };
}

export function updateDynamicGuidance(
  state: DynamicGuidanceState,
  route: DynamicRoute,
  sample: GuidanceLocation,
  config: DynamicGuidanceConfig,
): DynamicGuidanceUpdate {
  if (state.phase === "entrance_search" || state.phase === "arrived") {
    return { state, announcement: null, offRoute: false };
  }

  if (sample.accuracyM === null || sample.accuracyM > config.maxHorizontalAccuracyM) {
    return {
      state: { ...state, skippedSamples: state.skippedSamples + 1 },
      announcement: null,
      offRoute: false,
    };
  }

  const distanceToDestinationM = distanceMeters(sample, route.destination.position);
  const offRouteDistanceM = distanceToPolylineMeters(sample, route.geometry);

  let stepIndex = state.stepIndex;
  while (
    stepIndex < route.steps.length - 1 &&
    distanceMeters(sample, route.steps[stepIndex].end) <= config.stepAdvanceRadiusM
  ) {
    stepIndex += 1;
  }

  const step = route.steps[stepIndex];
  const distanceToStepEndM = distanceMeters(sample, step.end);
  const next = { ...state, stepIndex, distanceToDestinationM, distanceToStepEndM, offRouteDistanceM };
  next.usableSamples = state.usableSamples + 1;

  if (distanceToDestinationM <= config.arrivalRadiusM) {
    const announcement = `You are about ${roundMeters(distanceToDestinationM)} metres from ${route.destination.name}. Point the camera ahead and I will look for the entrance.`;
    return {
      state: { ...next, phase: "entrance_search", lastInstruction: announcement, offRouteSamples: 0 },
      announcement,
      offRoute: false,
    };
  }

  next.offRouteSamples =
    offRouteDistanceM > config.offRouteRadiusM ? state.offRouteSamples + 1 : 0;
  const offRoute = next.offRouteSamples >= config.offRouteSamplesRequired;

  if (stepIndex !== state.announcedStepIndex) {
    const announcement = stepAnnouncement(step, distanceToStepEndM);
    return {
      state: { ...next, announcedStepIndex: stepIndex, warnedStepIndex: null, lastInstruction: announcement },
      announcement,
      offRoute,
    };
  }

  const upcoming = route.steps[stepIndex + 1];
  if (
    upcoming &&
    stepIndex !== state.warnedStepIndex &&
    distanceToStepEndM <= config.turnWarningRadiusM
  ) {
    const announcement = `In about ${roundMeters(distanceToStepEndM)} metres, ${lowerFirst(upcoming.instructionText)}`;
    return {
      state: { ...next, warnedStepIndex: stepIndex, lastInstruction: announcement },
      announcement,
      offRoute,
    };
  }

  return { state: next, announcement: null, offRoute };
}

/**
 * Course over ground is unavailable while the user stands still, so a stationary
 * "which way" answer has to come from the compass instead.
 */
export function describeRelativeDirection(bearingDeg: number, headingDeg: number): string {
  const offset = signedHeadingDifference(bearingDeg, headingDeg);
  const magnitude = Math.abs(offset);
  const side = offset >= 0 ? "right" : "left";

  if (magnitude <= 20) return "straight ahead";
  if (magnitude <= 55) return `slightly to your ${side}`;
  if (magnitude <= 110) return `to your ${side}`;
  if (magnitude <= 155) return `behind you on the ${side}`;
  return "behind you";
}

export function guidanceTarget(state: DynamicGuidanceState, route: DynamicRoute): GeoPoint {
  if (state.phase === "entrance_search" || state.phase === "arrived") {
    return route.destination.position;
  }
  return route.steps[Math.min(state.stepIndex, route.steps.length - 1)].end;
}

export function bearingToTarget(sample: GeoPoint, target: GeoPoint): number {
  return bearingDegrees(sample, target);
}

export function roundMeters(meters: number): number {
  if (meters < 100) return Math.max(5, Math.round(meters / 5) * 5);
  if (meters < 1000) return Math.round(meters / 10) * 10;
  return Math.round(meters / 50) * 50;
}

function stepAnnouncement(
  step: DynamicRoute["steps"][number],
  distanceToStepEndM: number,
): string {
  const instruction = endWithStop(step.instructionText);
  const remaining = Math.min(step.distanceMeters, distanceToStepEndM);
  if (remaining < 20) return instruction;
  return `${instruction} Continue for about ${roundMeters(remaining)} metres.`;
}

function signedHeadingDifference(bearingDeg: number, headingDeg: number): number {
  const difference = ((bearingDeg - headingDeg + 540) % 360) - 180;
  return difference;
}

function endWithStop(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function lowerFirst(text: string): string {
  const trimmed = endWithStop(text.trim());
  if (trimmed.length < 2) return trimmed;
  // Street names and compass words keep their capitals, so only relax a word
  // that is capitalised purely because it started the sentence.
  const firstWord = trimmed.split(" ", 1)[0];
  if (firstWord.length > 1 && firstWord.slice(1) !== firstWord.slice(1).toLowerCase()) {
    return trimmed;
  }
  return trimmed[0].toLowerCase() + trimmed.slice(1);
}
