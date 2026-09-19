import {
  routeManifestSchema,
  type RouteManifest,
} from "@blind-maps/contracts";

export type RouteLoadResult =
  | { available: true; manifest: RouteManifest }
  | { available: false; errors: string[] };

export function loadRouteManifest(input: unknown): RouteLoadResult {
  const result = routeManifestSchema.safeParse(input);
  if (result.success) return { available: true, manifest: result.data };
  return {
    available: false,
    errors: result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `${path}${issue.message}`;
    }),
  };
}
