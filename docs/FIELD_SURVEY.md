# Field survey

No route has been surveyed yet. Live guidance stays locked until A and B verify the route in person and load a manifest that passes the runtime schema.

Do not copy coordinates from a web map or use the building center. Record phone fixes on the path and at the selected entrance. The first demo route must avoid road crossings.

## Survey record

Fill this section during the accompanied walk.

- Survey date:
- Surveyors:
- Start description:
- Selected entrance:
- Vestibule confirmation point:
- Demo access hours:
- Weather and construction:
- Camera-alignment stopping point:

## Anchor measurements

Record several fixes at each outdoor anchor. Keep the raw readings here, then choose a representative point for the manifest.

| Anchor id | Kind | Latitude | Longitude | Reported accuracy | Visible text or landmark | Photo path |
| --- | --- | --- | --- | --- | --- | --- |
| | start | | | | | |
| | outdoor_landmark | | | | | |
| | entrance | | | | | |
| | vestibule | not used | not used | not used | | |

## Segment checks

For each segment, record the exact instruction, turns, ramps, steps, barriers, door operation, and a polyline sampled along the walked path. Note any adjacent entrance that the camera could confuse with the selected door.

| Segment id | From | To | Environment | Instruction | Visual check | User check |
| --- | --- | --- | --- | --- | --- | --- |
| | | | outdoor | | | |
| | | | entrance | | | |

## Entrance and vestibule evidence

- Selected entrance text:
- Door position and operation:
- Distinctive entrance landmarks:
- Vestibule layout:
- Distinctive vestibule evidence:
- Conditions that require another camera view:
- Conditions that make the route unavailable:

Exclude identifiable bystanders from reference photos where practical. Store only the chosen development photos.

## Activation

1. Add the reviewed JSON manifest under `data/routes`.
2. Import it in `apps/mobile/src/navigation/active-route.ts` and pass it to `loadRouteManifest`.
3. Run `npm run typecheck` and `npm test`.
4. Keep `EXPO_PUBLIC_GOOGLE_ROUTES_ENABLED=false` for the first surveyed fallback walk.
5. Complete that walk before testing a Google candidate.

The manifest must have ordered segments from the start anchor to the vestibule. Every outdoor anchor needs a measured position. The entrance handoff needs visual confirmation. The final segment needs both visual and user confirmation.
