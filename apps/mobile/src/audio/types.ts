/** Mirrors the audio shapes in section 6.1 of HACKATHON_PLAN.md. */
export interface AudioChunk {
  codec: "pcm_s16le";
  sampleRateHz: number;
  channels: 1;
  chunkIndex: number;
  pcmBase64: string;
}

export interface CapturedAudioChunk extends AudioChunk {
  capturedAtMonotonicMs: number;
  durationMs: number;
  peakLevel: number;
}

export interface PlayableChunk {
  utteranceId: string;
  epoch: number;
  sampleRateHz: number;
  samples: Int16Array;
}

export type EnqueueResult =
  | "queued"
  | "stale-epoch"
  | "stale-utterance"
  | "queue-full"
  | "stopped";
