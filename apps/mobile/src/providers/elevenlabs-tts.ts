import { providerConfig } from "./config";

const elevenLabsApiBaseUrl = "https://api.elevenlabs.io/v1";

export interface SynthesizedSpeech {
  bytes: ArrayBuffer;
  contentType: string;
}

export async function synthesizeSpeech(text: string): Promise<SynthesizedSpeech> {
  if (!text.trim()) {
    throw new Error("Speech text cannot be empty");
  }

  const url = new URL(
    `${elevenLabsApiBaseUrl}/text-to-speech/${encodeURIComponent(providerConfig.elevenLabsVoiceId)}/stream`,
  );
  url.searchParams.set("output_format", providerConfig.elevenLabsTtsOutputFormat);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": providerConfig.elevenLabsApiKey,
    },
    body: JSON.stringify({
      text,
      model_id: providerConfig.elevenLabsTtsModelId,
    }),
  });

  if (!response.ok) {
    throw new Error(`ElevenLabs TTS failed (${response.status}): ${await response.text()}`);
  }

  return {
    bytes: await response.arrayBuffer(),
    contentType: response.headers.get("content-type") ?? "application/octet-stream",
  };
}
