import { loadRouteManifest } from "@blind-maps/navigation";

/*
 * Replace this value only after the field survey has produced a complete,
 * reviewed manifest in data/routes. A null value blocks live guidance so the
 * app cannot use guessed coordinates.
 */
const verifiedRouteInput: unknown = null;

export const activeRouteLoadResult = loadRouteManifest(verifiedRouteInput);
