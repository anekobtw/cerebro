/** Mirrors the camera shape in section 6.1 of HACKATHON_PLAN.md. */
export interface CameraFrame {
  frameId: string;
  capturedAtMonotonicMs: number;
  mimeType: "image/jpeg";
  width: number;
  height: number;
  jpegBase64: string;
}
