export * from "./dynamic-guidance.js";
export * from "./geometry.js";
export * from "./manifest.js";
export * from "./reducer.js";

export interface RouteModule {
  readonly routeId: string | null;
  readonly routeRevision: number;
}

export function requireAvailableRoute(route: RouteModule): string {
  if (route.routeId === null) {
    throw new Error("No surveyed route is available");
  }
  return route.routeId;
}
