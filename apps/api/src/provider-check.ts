import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { config as loadEnv } from "dotenv";
import { GoogleGenAI, Modality, type LiveServerMessage } from "@google/genai";

loadEnv({ path: resolve(import.meta.dirname, "../.env") });

type ProviderCheckResult = {
  gemini: {
    model: string;
    firstResponse: string;
    secondResponse: string;
    responsesDiffer: boolean;
  };
  elevenLabs: {
    model: string;
    outputFormat: string;
    contentType: string;
    byteLength: number;
    characterLimit: number | null;
    characterCount: number | null;
  };
  usageLimitUsd: number;
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requiredOneOf(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }

  throw new Error(`One of ${names.join(", ")} is required`);
}

function optionalPath(name: string): string {
  const value = required(name);
  return resolve(value);
}

async function readPcm16Mono16Khz(path: string): Promise<Buffer> {
  const pcm = await readFile(path);
  if (pcm.length === 0 || pcm.length % 2 !== 0) {
    throw new Error(`${path} must be non-empty 16-bit PCM`);
  }

  const durationSeconds = pcm.length / (16_000 * 2);
  if (durationSeconds > 15) {
    throw new Error(`${path} is ${durationSeconds.toFixed(1)} seconds; use an utterance of 15 seconds or less`);
  }

  return pcm;
}

async function readJpeg(path: string): Promise<Buffer> {
  const jpeg = await readFile(path);
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[jpeg.length - 2] !== 0xff || jpeg[jpeg.length - 1] !== 0xd9) {
    throw new Error(`${path} must be a JPEG image`);
  }
  return jpeg;
}


function waitForTurn(session: { sendClientContent(input: object): void }, prompt: string, timeoutMs = 20_000): Promise<string> {
  const completion = Promise.withResolvers<string>();
  const timer = setTimeout(() => {
    completion.reject(new Error(`Timed out waiting for Gemini response to: ${prompt}`));
  }, timeoutMs);
  const responses: string[] = [];

  activeTurn = {
    onMessage(message) {
      const text = message.text?.trim() ?? "";
      if (text) {
        responses.push(text);
      }
      if (message.serverContent?.turnComplete === true) {
        clearTimeout(timer);
        activeTurn = null;
        completion.resolve(responses.join("\n"));
      }
    },
    onError(error) {
      clearTimeout(timer);
      activeTurn = null;
      completion.reject(error);
    },
  };

  session.sendClientContent({
    turns: [{ role: "user", parts: [{ text: prompt }] }],
    turnComplete: true,
  });
  return completion.promise;
}

let activeTurn: {
  onMessage(message: LiveServerMessage): void;
  onError(error: Error): void;
} | null = null;

async function checkGemini(): Promise<ProviderCheckResult["gemini"]> {
  const apiKey = requiredOneOf("GEMINI_API_KEY", "GOOGLE_API_KEY");
  const model = required("GEMINI_MODEL");
  const firstImage = await readJpeg(optionalPath("PROVIDER_CHECK_IMAGE_PATH"));
  const secondImage = await readJpeg(optionalPath("PROVIDER_CHECK_SECOND_IMAGE_PATH"));
  const audio = await readPcm16Mono16Khz(optionalPath("PROVIDER_CHECK_AUDIO_PATH"));

  if (firstImage.equals(secondImage)) {
    throw new Error("PROVIDER_CHECK_IMAGE_PATH and PROVIDER_CHECK_SECOND_IMAGE_PATH must contain different scenes");
  }

  const ai = new GoogleGenAI({ apiKey });
  const session = await ai.live.connect({
    model,
    config: { responseModalities: [Modality.TEXT] },
    callbacks: {
      onmessage: (message) => activeTurn?.onMessage(message),
      onerror: (event) => activeTurn?.onError(new Error(String(event))),
      onclose: (event) => activeTurn?.onError(new Error(`Gemini session closed: ${event.reason}`)),
    },
  });

  try {
    session.sendRealtimeInput({
      audio: { data: audio.toString("base64"), mimeType: "audio/pcm;rate=16000" },
    });
    session.sendRealtimeInput({
      video: { data: firstImage.toString("base64"), mimeType: "image/jpeg" },
    });
    const firstResponse = await waitForTurn(
      session,
      "Route context: the user is approaching the USF Tampa Library. Describe only visible, route-relevant details in the current camera frame.",
    );

    session.sendRealtimeInput({
      video: { data: secondImage.toString("base64"), mimeType: "image/jpeg" },
    });
    const secondResponse = await waitForTurn(
      session,
      "This is a new camera scene. Describe the visible route-relevant differences from the previous frame.",
    );

    if (!firstResponse || !secondResponse) {
      throw new Error("Gemini returned an empty text response");
    }

    return {
      model,
      firstResponse,
      secondResponse,
      responsesDiffer: firstResponse !== secondResponse,
    };
  } finally {
    session.close();
  }
}

async function checkElevenLabs(): Promise<ProviderCheckResult["elevenLabs"]> {
  const apiKey = required("ELEVENLABS_API_KEY");
  const voiceId = required("ELEVENLABS_VOICE_ID");
  const model = required("ELEVENLABS_MODEL_ID");
  const outputFormat = required("ELEVENLABS_OUTPUT_FORMAT");
  const endpoint = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`);
  endpoint.searchParams.set("output_format", outputFormat);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "xi-api-key": apiKey },
    body: JSON.stringify({ text: "Provider check complete.", model_id: model }),
  });
  if (!response.ok) {
    throw new Error(`ElevenLabs TTS failed (${response.status}): ${await response.text()}`);
  }

  const audio = await response.arrayBuffer();
  if (audio.byteLength === 0) {
    throw new Error("ElevenLabs returned an empty audio response");
  }

  const subscription = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
    headers: { "xi-api-key": apiKey },
  });
  let characterLimit: number | null = null;
  let characterCount: number | null = null;
  if (subscription.ok) {
    const usage: unknown = await subscription.json();
    if (usage !== null && typeof usage === "object") {
      if ("character_limit" in usage && typeof usage.character_limit === "number") {
        characterLimit = usage.character_limit;
      }
      if ("character_count" in usage && typeof usage.character_count === "number") {
        characterCount = usage.character_count;
      }
    }
  }

  return {
    model,
    outputFormat,
    contentType: response.headers.get("content-type") ?? "unknown",
    byteLength: audio.byteLength,
    characterLimit,
    characterCount,
  };
}

async function main(): Promise<void> {
  const usageLimitUsd = Number(required("PROVIDER_CHECK_MAX_COST_USD"));
  if (!Number.isFinite(usageLimitUsd) || usageLimitUsd <= 0) {
    throw new Error("PROVIDER_CHECK_MAX_COST_USD must be a positive number");
  }

  const result: ProviderCheckResult = {
    gemini: await checkGemini(),
    elevenLabs: await checkElevenLabs(),
    usageLimitUsd,
  };

  console.log(JSON.stringify(result, null, 2));
  if (!result.gemini.responsesDiffer) {
    throw new Error("Gemini responses did not change between the two distinct scenes");
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
