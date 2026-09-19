import { z } from "zod";

export const providerModeSchema = z.enum([
  "mock",
  "gemini_text_elevenlabs",
  "gemini_native",
]);

export type ProviderMode = z.infer<typeof providerModeSchema>;

export const PROTOCOL_VERSION = 1 as const;

export const geoPointSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
});

export type GeoPoint = z.infer<typeof geoPointSchema>;

export const routeAnchorKindSchema = z.enum([
  "start",
  "outdoor_landmark",
  "entrance",
  "vestibule",
  "exit",
]);

export const routeAnchorSchema = z.object({
  id: z.string().min(1),
  kind: routeAnchorKindSchema,
  position: geoPointSchema.nullable(),
  expectedVisibleText: z.array(z.string().min(1)),
  visualDescription: z.string().min(1),
  referenceImagePaths: z.array(z.string().min(1)),
});

export type RouteAnchor = z.infer<typeof routeAnchorSchema>;

export const routeSegmentSchema = z.object({
  id: z.string().min(1),
  fromAnchorId: z.string().min(1),
  toAnchorId: z.string().min(1),
  environment: z.enum(["outdoor", "entrance", "indoor"]),
  polyline: z.array(geoPointSchema),
  instructionId: z.string().min(1),
  instructionText: z.string().min(1),
  requiresVisualConfirmation: z.boolean(),
  requiresUserConfirmation: z.boolean(),
});

export type RouteSegment = z.infer<typeof routeSegmentSchema>;

export const routeManifestSchema = z
  .object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    surveyedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    destinationName: z.string().min(1),
    startAnchorId: z.string().min(1),
    arrivalAnchorId: z.string().min(1),
    supportedStartRadiusM: z.number().positive(),
    handoffAnchorId: z.string().min(1),
    anchors: z.array(routeAnchorSchema).min(3),
    segments: z.array(routeSegmentSchema).min(2),
  })
  .superRefine((manifest, context) => {
    const anchorIds = new Set<string>();
    for (const [index, anchor] of manifest.anchors.entries()) {
      if (anchorIds.has(anchor.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate anchor id: ${anchor.id}`,
          path: ["anchors", index, "id"],
        });
      }
      anchorIds.add(anchor.id);
    }

    const requiredAnchorIds = [
      manifest.startAnchorId,
      manifest.handoffAnchorId,
      manifest.arrivalAnchorId,
    ];
    for (const anchorId of requiredAnchorIds) {
      if (!anchorIds.has(anchorId)) {
        context.addIssue({
          code: "custom",
          message: `Unknown required anchor: ${anchorId}`,
          path: ["anchors"],
        });
      }
    }

    const startAnchor = manifest.anchors.find(
      (anchor) => anchor.id === manifest.startAnchorId,
    );
    const handoffAnchor = manifest.anchors.find(
      (anchor) => anchor.id === manifest.handoffAnchorId,
    );
    const arrivalAnchor = manifest.anchors.find(
      (anchor) => anchor.id === manifest.arrivalAnchorId,
    );
    if (startAnchor?.kind !== "start" || startAnchor.position === null) {
      context.addIssue({
        code: "custom",
        message: "The start anchor must have kind start and a surveyed position",
        path: ["startAnchorId"],
      });
    }
    if (handoffAnchor?.kind !== "entrance" || handoffAnchor.position === null) {
      context.addIssue({
        code: "custom",
        message: "The handoff anchor must have kind entrance and a surveyed position",
        path: ["handoffAnchorId"],
      });
    }
    if (arrivalAnchor?.kind !== "vestibule") {
      context.addIssue({
        code: "custom",
        message: "The arrival anchor must have kind vestibule",
        path: ["arrivalAnchorId"],
      });
    }

    const segmentIds = new Set<string>();
    let expectedFrom = manifest.startAnchorId;
    for (const [index, segment] of manifest.segments.entries()) {
      if (segmentIds.has(segment.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate segment id: ${segment.id}`,
          path: ["segments", index, "id"],
        });
      }
      segmentIds.add(segment.id);

      if (!anchorIds.has(segment.fromAnchorId) || !anchorIds.has(segment.toAnchorId)) {
        context.addIssue({
          code: "custom",
          message: "Every segment endpoint must name a known anchor",
          path: ["segments", index],
        });
      }
      if (segment.fromAnchorId !== expectedFrom) {
        context.addIssue({
          code: "custom",
          message: `Expected segment to start at ${expectedFrom}`,
          path: ["segments", index, "fromAnchorId"],
        });
      }
      expectedFrom = segment.toAnchorId;

      if (segment.environment === "outdoor" && segment.polyline.length < 2) {
        context.addIssue({
          code: "custom",
          message: "Outdoor segments need at least two surveyed polyline points",
          path: ["segments", index, "polyline"],
        });
      }
      if (segment.environment === "outdoor") {
        const from = manifest.anchors.find(
          (anchor) => anchor.id === segment.fromAnchorId,
        );
        const to = manifest.anchors.find(
          (anchor) => anchor.id === segment.toAnchorId,
        );
        if (!from?.position || !to?.position) {
          context.addIssue({
            code: "custom",
            message: "Outdoor segment anchors need surveyed positions",
            path: ["segments", index],
          });
        }
      }
    }

    if (expectedFrom !== manifest.arrivalAnchorId) {
      context.addIssue({
        code: "custom",
        message: "The ordered segment chain must end at the arrival anchor",
        path: ["segments"],
      });
    }

    const handoffIndex = manifest.segments.findIndex(
      (segment) => segment.toAnchorId === manifest.handoffAnchorId,
    );
    if (handoffIndex < 0 || manifest.segments[handoffIndex]?.environment !== "outdoor") {
      context.addIssue({
        code: "custom",
        message: "An outdoor segment must end at the handoff anchor",
        path: ["handoffAnchorId"],
      });
    }
    if (
      handoffIndex >= 0 &&
      !manifest.segments.slice(handoffIndex).some((segment) => segment.requiresVisualConfirmation)
    ) {
      context.addIssue({
        code: "custom",
        message: "The entrance and vestibule sequence needs visual confirmation",
        path: ["segments"],
      });
    }
    const finalSegment = manifest.segments.at(-1);
    if (
      !finalSegment?.requiresUserConfirmation ||
      !finalSegment.requiresVisualConfirmation
    ) {
      context.addIssue({
        code: "custom",
        message: "The final segment must require visual and user confirmation",
        path: ["segments", Math.max(0, manifest.segments.length - 1)],
      });
    }
  });

export type RouteManifest = z.infer<typeof routeManifestSchema>;

export const navigationPhaseSchema = z.enum([
  "ready",
  "destination_confirmation",
  "alignment",
  "outdoor",
  "entrance_search",
  "vestibule_confirmation",
  "arrived",
]);

export type NavigationPhase = z.infer<typeof navigationPhaseSchema>;

export const navigationProgressSchema = z.object({
  routeId: z.string().nullable(),
  phase: navigationPhaseSchema,
  paused: z.boolean(),
  segmentId: z.string().nullable(),
  instructionId: z.string().nullable(),
  routeRevision: z.number().int().nonnegative(),
});

export type NavigationProgress = z.infer<typeof navigationProgressSchema>;

export const sceneObservationSchema = z.object({
  analysisId: z.string().min(1),
  sourceFrameId: z.string().min(1),
  sourceCapturedAtMonotonicMs: z.number().finite().nonnegative(),
  visibleText: z.array(z.string()),
  candidateAnchorIds: z.array(z.string()),
  doorPositionInImage: z.enum(["left", "center", "right", "unknown"]),
  viewUsable: z.boolean(),
  requiresAnotherView: z.boolean(),
  description: z.string(),
});

export type SceneObservation = z.infer<typeof sceneObservationSchema>;

export const safetyObservationSchema = z.object({
  analysisId: z.string().min(1),
  sourceFrameId: z.string().min(1),
  sourceCapturedAtMonotonicMs: z.number().finite().nonnegative(),
  hazardLevel: z.enum(["clear", "caution", "danger", "unknown"]),
  obstacle: z.string(),
  instruction: z.string(),
  viewUsable: z.boolean(),
});

export type SafetyObservation = z.infer<typeof safetyObservationSchema>;

export const userIntentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("request_destination"), destinationId: z.string().min(1) }),
  z.object({ kind: z.literal("confirm_destination") }),
  z.object({ kind: z.literal("pause") }),
  z.object({ kind: z.literal("resume") }),
  z.object({ kind: z.literal("repeat") }),
  z.object({ kind: z.literal("describe_scene") }),
  z.object({ kind: z.literal("confirm_vestibule") }),
  z.object({ kind: z.literal("cancel") }),
]);

export type UserIntent = z.infer<typeof userIntentSchema>;

export const outdoorRouteFallbackReasonSchema = z.enum([
  "disabled",
  "timeout",
  "api_error",
  "route_rejected",
]);

export const sessionOutdoorRouteSchema = z.object({
  source: z.enum(["google_routes", "surveyed"]),
  surveyedRouteId: z.string().min(1),
  surveyedRouteVersion: z.number().int().positive(),
  handoffAnchorId: z.string().min(1),
  outdoorGeometry: z.array(geoPointSchema).min(2),
  distanceMeters: z.number().finite().nonnegative(),
  estimatedDurationSeconds: z.number().finite().nonnegative().nullable(),
  providerWarnings: z.array(z.string()),
  fallbackReason: outdoorRouteFallbackReasonSchema.optional(),
});

export type SessionOutdoorRoute = z.infer<typeof sessionOutdoorRouteSchema>;
