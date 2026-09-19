import { providerConfig } from "./config";

const elevenLabsApiBaseUrl = "https://api.elevenlabs.io/v1";

export interface SynthesizedSpeech {
  bytes: ArrayBuffer;
  contentType: string;
  sampleRateHz: number;
}

function speechRequest(text: string) {
  if (!text.trim()) throw new Error("Speech text cannot be empty");
  const sampleRateHz = speechSampleRateHz();
  const url = new URL(
    `${elevenLabsApiBaseUrl}/text-to-speech/${encodeURIComponent(providerConfig.elevenLabsVoiceId)}/stream`,
  );
  url.searchParams.set("output_format", providerConfig.elevenLabsTtsOutputFormat);
  return {
    url: url.toString(),
    sampleRateHz,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": providerConfig.elevenLabsApiKey,
      },
      body: JSON.stringify({ text, model_id: providerConfig.elevenLabsTtsModelId }),
    },
  };
}

export function speechSampleRateHz(): number {
  const match = /^pcm_(8000|16000|22050|24000|44100|48000)$/.exec(providerConfig.elevenLabsTtsOutputFormat);
  if (!match) throw new Error("ElevenLabs playback requires a PCM output format, such as pcm_24000");
  return Number(match[1]);
}

export async function synthesizeSpeech(text: string, signal?: AbortSignal): Promise<SynthesizedSpeech> {
  const request = speechRequest(text);
  const response = await fetch(request.url, { ...request.init, signal });
  if (!response.ok) {
    throw new Error(`ElevenLabs TTS failed (${response.status}): ${await response.text()}`);
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0) {
    throw new Error("ElevenLabs TTS returned invalid PCM16 audio");
  }
  return {
    bytes,
    sampleRateHz: request.sampleRateHz,
    contentType: response.headers.get("content-type") ?? "application/octet-stream",
  };
}

/** Expo fetch exposes the native response stream without buffering the whole utterance. */
export async function streamSpeech(
  text: string,
  onAudio: (chunk: SynthesizedSpeech) => void,
  signal: AbortSignal,
): Promise<void> {
  const request = speechRequest(text);
  const { fetch: streamingFetch } = await import("expo/fetch");
  const response = await streamingFetch(request.url, { ...request.init, signal });
  if (!response.ok) {
    throw new Error(`ElevenLabs TTS failed (${response.status}): ${await response.text()}`);
  }
  if (!response.body) throw new Error("ElevenLabs TTS returned no audio stream");

  const reader = response.body.getReader();
  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  let leftover: number | null = null;
  let receivedBytes = 0;
  let completed = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (signal.aborted) throw new Error("Speech cancelled");
      if (done) { completed = true; break; }
      if (!value?.length) continue;
      // A network chunk can end halfway through a PCM16 sample.
      const joined: Uint8Array = new Uint8Array(
        value.length + (leftover === null ? 0 : 1),
      );
      if (leftover !== null) joined[0] = leftover;
      joined.set(value, leftover === null ? 0 : 1);
      const evenByteLength: number = joined.length - joined.length % 2;
      leftover = evenByteLength === joined.length ? null : joined[evenByteLength];
      if (evenByteLength === 0) continue;
      receivedBytes += evenByteLength;
      onAudio({
        bytes: joined.slice(0, evenByteLength).buffer,
        sampleRateHz: request.sampleRateHz,
        contentType,
      });
    }
    if (leftover !== null || receivedBytes === 0) {
      throw new Error("ElevenLabs TTS returned invalid PCM16 audio");
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
