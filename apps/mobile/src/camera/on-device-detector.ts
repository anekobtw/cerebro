import { NativeModules, Platform } from "react-native";

import type { CameraFrame } from "./types";

export interface DetectedObject {
  left: number;
  top: number;
  right: number;
  bottom: number;
  labels: string[];
}

interface ObjectDetectionModule {
  detectJpeg(base64Jpeg: string): Promise<{ objects: DetectedObject[] }>;
}

const nativeModule = NativeModules.CerebroObjectDetection as ObjectDetectionModule | undefined;

/** Returns no result on non-Android builds, where the native ML Kit module is unavailable. */
export async function detectObjects(frame: CameraFrame): Promise<DetectedObject[] | null> {
  if (Platform.OS !== "android" || !nativeModule) return null;
  const result = await nativeModule.detectJpeg(frame.jpegBase64);
  return result.objects;
}

export function objectCue(objects: readonly DetectedObject[]): string | null {
  if (objects.length === 0) return null;
  const nearestCentral = objects.find((item) => item.left < 0.6 && item.right > 0.4) ?? objects[0];
  const label = nearestCentral.labels[0]?.trim();
  return label ? `Possible ${label.toLowerCase()} ahead. Stop and check surroundings.` :
    "Possible object ahead. Stop and check surroundings.";
}
