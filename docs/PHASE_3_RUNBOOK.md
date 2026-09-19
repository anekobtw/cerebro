# Phase 3 route runbook

The route code fails closed while `active-route.ts` contains `null`. The app can still answer scene questions, but it shows that route guidance is locked.

## Load the surveyed route

Complete [the field survey](FIELD_SURVEY.md), add the reviewed manifest under `data/routes`, then import that JSON in `apps/mobile/src/navigation/active-route.ts`:

```ts
import verifiedRouteInput from "../../../../data/routes/usf-tampa-library.json";
```

Do not enable the route if validation reports an unknown anchor, a broken segment chain, a missing outdoor polyline, or missing entrance and vestibule checks.

## Check the surveyed fallback

Leave Google routing off:

```dotenv
EXPO_PUBLIC_GOOGLE_ROUTES_ENABLED=false
```

Start the Android development build at the measured start area. Confirm these behaviors:

1. A destination request asks for confirmation.
2. Confirmation outside the supported start radius refuses guidance.
3. Poor GPS accuracy asks the user to stop and wait.
4. A usable camera view is required before relative guidance starts.
5. Three consistent GPS samples advance an outdoor waypoint.
6. Sustained corridor deviation stops sensor streaming and pauses the route.
7. Pause and resume keep the current segment.
8. GPS proximity enters the entrance search but cannot announce arrival.
9. The selected entrance and vestibule each need a current model observation.
10. The user's spoken inside confirmation expires if the vestibule view is more than three seconds old.
11. Arrival plays once.

The diagnostics panel must show `surveyed`, zero route requests, and fallback reason `disabled`.

## Check Google Routes

Enable Routes API billing and set a small quota in the development Google Cloud project. Restrict the key to the Routes API. Put the local key in `.env`:

```dotenv
EXPO_PUBLIC_GOOGLE_ROUTES_ENABLED=true
EXPO_PUBLIC_GOOGLE_MAPS_API_KEY=restricted-development-key
EXPO_PUBLIC_GOOGLE_MAPS_REQUEST_TIMEOUT_MS=5000
```

The app makes one `computeRoutes` request after destination confirmation. It requests a walking route from the fresh start fix to the surveyed entrance handoff. The app accepts the candidate only if both snapped endpoints and every decoded point stay within the surveyed limits.

Inspect these diagnostics on the Pixel:

- Route source is `google_routes`.
- Route requests is `1`.
- The returned warnings are readable.
- The screen shows Google attribution.
- Entrance and vestibule checks still use surveyed anchors.

Then force a quota or network failure. Guidance must start with the surveyed route, route requests must remain `1`, and the fallback reason must be `api_error` or `timeout`. A candidate outside the corridor must use fallback reason `route_rejected`.

Never retry on each GPS update or switch geometry during a walk.

## Current block

This repository has no measured route manifest yet. The automated checks cover validation, route selection, GPS hysteresis, deviation, stale model output, pause and resume, and ordered arrival. They do not replace the accompanied Pixel walk.
