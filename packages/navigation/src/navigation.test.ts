import { describe, expect, it } from "vitest";

import { requireAvailableRoute, type RouteModule } from "./index.js";

describe("requireAvailableRoute", () => {
  it("prevents navigation when no surveyed route is available", () => {
    const route: RouteModule = { routeId: null, routeRevision: 0 };

    expect(() => requireAvailableRoute(route)).toThrow(
      "No surveyed route is available",
    );
  });

  it("returns the surveyed route identifier when available", () => {
    const route: RouteModule = {
      routeId: "surveyed-library-route",
      routeRevision: 1,
    };

    expect(requireAvailableRoute(route)).toBe("surveyed-library-route");
  });
});
