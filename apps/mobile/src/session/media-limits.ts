export const CAMERA_INPUT_FPS = 1;
export const CAMERA_CAPTURE_INTERVAL_MS = 1_000 / CAMERA_INPUT_FPS;
export const TARGET_IMAGE_BYTES = 150 * 1_024;
export const TARGET_AUDIO_CHUNK_MS = 40;
// Live responses can arrive much faster than the speaker plays them.
export const MAX_PLAYBACK_QUEUE_MS = 30_000;
