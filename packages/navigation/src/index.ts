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
