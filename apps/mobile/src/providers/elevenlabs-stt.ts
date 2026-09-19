import { providerConfig } from "./config";

const speechToTextEndpoint = "https://api.elevenlabs.io/v1/speech-to-text";

export interface Transcription {
  text: string;
  languageCode: string;
  languageProbability: number;
}

export async function transcribeAudio(options: {
  audio: Blob;
  fileName: string;
  languageCode?: string;
}): Promise<Transcription> {
  if (options.audio.size === 0) {
    throw new Error("Audio cannot be empty");
  }

  const body = new FormData();
  body.append("file", options.audio, options.fileName);
  body.append("model_id", providerConfig.elevenLabsSttModelId);
  body.append("file_format", "pcm_s16le_16");
  body.append("language_code", options.languageCode ?? "en");

  const response = await fetch(speechToTextEndpoint, {
    method: "POST",
    headers: {
      "xi-api-key": providerConfig.elevenLabsApiKey,
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`ElevenLabs STT failed (${response.status}): ${await response.text()}`);
  }

  const result: unknown = await response.json();
  if (
    typeof result !== "object" ||
    result === null ||
    !("text" in result) ||
    !("language_code" in result) ||
    !("language_probability" in result) ||
    typeof result.text !== "string" ||
    typeof result.language_code !== "string" ||
    typeof result.language_probability !== "number"
  ) {
    throw new Error("ElevenLabs STT returned an unexpected response");
  }

  return {
    text: result.text,
    languageCode: result.language_code,
    languageProbability: result.language_probability,
  };
}
