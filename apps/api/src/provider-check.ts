import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

import { config as loadEnv } from "dotenv";
import {
  GoogleGenAI,
  Modality,
  type FunctionCall,
  type FunctionDeclaration,
  type LiveServerMessage,
} from "@google/genai";

loadEnv({ path: resolve(import.meta.dirname, "../../../.env") });

type ProviderCheckResult = {
  gemini: {
    model: string;
    firstObservation: ObstacleObservation;
    secondObservation: ObstacleObservation;
  };
  elevenLabs: {
    transcription: {
      model: string;
      text: string;
      languageCode: string;
      languageProbability: number;
    };
    tts: {
      text: string;
      model: string;
      outputFormat: string;
      contentType: string;
      byteLength: number;
    };
    characterLimit: number | null;
    characterCount: number | null;
  };
  usageLimitUsd: number;
};
type ObstacleType = "person" | "vehicle" | "stairs" | "door" | "barrier" | "debris" | "unknown" | "none";
type ObstaclePosition = "left" | "center" | "right" | "across-path" | "unknown";
type ObstacleAction = "continue" | "stop" | "veer-left" | "veer-right" | "turn-back" | "wait";

type ObstacleObservation = {
  obstaclePresent: boolean;
  obstacleType: ObstacleType;
  position: ObstaclePosition;
  action: ObstacleAction;
  explanation: string;
  confidence: number;
};

const obstacleTypes: readonly ObstacleType[] = [
  "person",
  "vehicle",
  "stairs",
  "door",
  "barrier",
  "debris",
  "unknown",
  "none",
];
const obstaclePositions: readonly ObstaclePosition[] = ["left", "center", "right", "across-path", "unknown"];
const obstacleActions: readonly ObstacleAction[] = ["continue", "stop", "veer-left", "veer-right", "turn-back", "wait"];
const reportObstacleDeclaration: FunctionDeclaration = {
  name: "report_obstacle",
  description: "Report the obstacle status and safest immediate walking action for the supplied camera frame.",
  parametersJsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["obstaclePresent", "obstacleType", "position", "action", "explanation", "confidence"],
    properties: {
      obstaclePresent: { type: "boolean" },
      obstacleType: { type: "string", enum: obstacleTypes },
      position: { type: "string", enum: obstaclePositions },
      action: { type: "string", enum: obstacleActions },
      explanation: { type: "string", description: "Visible evidence and immediate action in at most 12 words." },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  },
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function optionalPath(name: string): string {
  const value = required(name);
  return resolve(value);
}

const speechToTextMediaTypes: Record<string, string> = {
  ".3gp": "video/3gpp",
  ".aac": "audio/aac",
  ".aiff": "audio/aiff",
  ".avi": "video/x-msvideo",
  ".flac": "audio/flac",
  ".flv": "video/x-flv",
  ".m4a": "audio/mp4",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".mpeg": "video/mpeg",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
  ".wmv": "video/x-ms-wmv",
};

type SpeechToTextInput = {
  audio: Buffer;
  fileFormat: "other" | "pcm_s16le_16";
  mediaType: string;
};

async function readSpeechToTextAudio(path: string): Promise<SpeechToTextInput> {
  const audio = await readFile(path);
  if (audio.length === 0) {
    throw new Error(`${path} must be non-empty`);
  }

  if (extname(path).toLowerCase() === ".pcm") {
    return { audio, fileFormat: "pcm_s16le_16", mediaType: "application/octet-stream" };
  }
  const mediaType = speechToTextMediaTypes[extname(path).toLowerCase()];
  if (!mediaType) {
    throw new Error(`${path} must be a supported ElevenLabs speech-to-text audio or video file`);
  }

  return { audio, fileFormat: "other", mediaType };
}

async function readJpeg(path: string): Promise<Buffer> {
  const jpeg = await readFile(path);
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[jpeg.length - 2] !== 0xff || jpeg[jpeg.length - 1] !== 0xd9) {
    throw new Error(`${path} must be a JPEG image`);
  }
  return jpeg;
}

type ObstacleSession = {
  sendClientContent(input: object): void;
  sendToolResponse(input: {
    functionResponses: Array<{
      id?: string;
      name?: string;
      response: Record<string, unknown>;
    }>;
  }): void;
};

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function parseObstacleCall(call: FunctionCall): ObstacleObservation {
  if (call.name !== reportObstacleDeclaration.name || !call.args) {
    throw new Error("Gemini returned an unexpected tool call");
  }

  const { obstaclePresent, obstacleType, position, action, explanation, confidence } = call.args;
  if (
    typeof obstaclePresent !== "boolean" ||
    !includes(obstacleTypes, obstacleType) ||
    !includes(obstaclePositions, position) ||
    !includes(obstacleActions, action) ||
    typeof explanation !== "string" ||
    explanation.trim().length === 0 ||
    explanation.trim().split(/\s+/).length > 12 ||
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    throw new Error("Gemini returned an invalid obstacle observation");
  }

  return {
    obstaclePresent,
    obstacleType,
    position,
    action,
    explanation: explanation.trim(),
    confidence,
  };
}

function waitForObstacle(
  session: ObstacleSession,
  image: Buffer,
  routeInstruction: string,
  timeoutMs = 20_000,
): Promise<ObstacleObservation> {
  const completion = Promise.withResolvers<ObstacleObservation>();
  let observation: ObstacleObservation | null = null;
  const fail = (error: Error) => {
    clearTimeout(timer);
    activeTurn = null;
    completion.reject(error);
  };
  const timer = setTimeout(() => {
    fail(new Error(`Timed out waiting for Gemini obstacle analysis: ${routeInstruction}`));
  }, timeoutMs);

  activeTurn = {
    onMessage(message) {
      try {
        for (const call of message.toolCall?.functionCalls ?? []) {
          if (observation !== null) {
            throw new Error("Gemini returned more than one obstacle observation");
          }
          observation = parseObstacleCall(call);
          session.sendToolResponse({
            functionResponses: [{
              id: call.id,
              name: call.name,
              response: { output: "Observation recorded" },
            }],
          });
        }

        if (message.serverContent?.turnComplete === true) {
          if (observation === null) {
            throw new Error("Gemini completed the turn without reporting an obstacle observation");
          }
          clearTimeout(timer);
          activeTurn = null;
          completion.resolve(observation);
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    },
    onError: fail,
  };

  session.sendClientContent({
    turns: [{
      role: "user",
      parts: [
        { inlineData: { data: image.toString("base64"), mimeType: "image/jpeg" } },
        {
          text: [
            `Planned route instruction: ${routeInstruction}`,
            "Inspect only this image and call report_obstacle exactly once.",
            "Never invent a route. If the image or safe direction is uncertain, choose stop.",
            "Choose veer-left or veer-right only when that side is visibly open.",
          ].join("\n"),
        },
      ],
    }],
    turnComplete: true,
  });
  return completion.promise;
}

let activeTurn: {
  onMessage(message: LiveServerMessage): void;
  onError(error: Error): void;
} | null = null;

async function checkGemini(): Promise<ProviderCheckResult["gemini"]> {
  const apiKey = required("GEMINI_API_KEY");
  const model = required("GEMINI_MODEL");
  const firstImage = await readJpeg(optionalPath("PROVIDER_CHECK_IMAGE_PATH"));
  const secondImage = await readJpeg(optionalPath("PROVIDER_CHECK_SECOND_IMAGE_PATH"));

  if (firstImage.equals(secondImage)) {
    throw new Error("PROVIDER_CHECK_IMAGE_PATH and PROVIDER_CHECK_SECOND_IMAGE_PATH must contain different scenes");
  }

  const ai = new GoogleGenAI({ apiKey });
  const session = await ai.live.connect({
    model,
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: [
        "You are an obstacle-awareness assistant for a blind pedestrian.",
        "For every supplied image, call report_obstacle exactly once.",
        "Report only visible evidence and the safest immediate action.",
        "Do not create or change the route.",
      ].join(" "),
      tools: [{ functionDeclarations: [reportObstacleDeclaration] }],
    },
    callbacks: {
      onmessage: (message) => activeTurn?.onMessage(message),
      onerror: (event) => activeTurn?.onError(new Error(String(event))),
      onclose: (event) => activeTurn?.onError(new Error(`Gemini session closed: ${event.reason}`)),
    },
  });

  try {
    const routeInstruction = "Continue straight toward the building entrance.";
    const firstObservation = await waitForObstacle(session, firstImage, routeInstruction);
    const secondObservation = await waitForObstacle(session, secondImage, routeInstruction);

    return {
      model,
      firstObservation,
      secondObservation,
    };
  } finally {
    session.close();
  }
}

function guidanceFor(observation: ObstacleObservation): string {
  if (observation.confidence < 0.75) {
    return "Stop. The path ahead is uncertain.";
  }
  if (!observation.obstaclePresent) {
    return observation.action === "continue"
      ? "No visible obstacle detected. Continue with caution."
      : "Stop. The path ahead is uncertain.";
  }

  switch (observation.action) {
    case "veer-left":
      return "Obstacle ahead. Move slightly left.";
    case "veer-right":
      return "Obstacle ahead. Move slightly right.";
    case "turn-back":
      return "Path blocked. Stop and turn back.";
    case "wait":
      return "Obstacle ahead. Wait.";
    case "continue":
    case "stop":
      return "Obstacle ahead. Stop.";
  }
}

async function checkElevenLabs(
  audioPath: string,
  input: SpeechToTextInput,
  guidance: string,
): Promise<ProviderCheckResult["elevenLabs"]> {
  const apiKey = required("ELEVENLABS_API_KEY");
  const sttModel = required("ELEVENLABS_STT_MODEL_ID");
  const voiceId = required("ELEVENLABS_VOICE_ID");
  const ttsModel = required("ELEVENLABS_TTS_MODEL_ID");
  const outputFormat = required("ELEVENLABS_TTS_OUTPUT_FORMAT");

  const transcriptionBody = new FormData();
  transcriptionBody.append("file", new Blob([Uint8Array.from(input.audio)], { type: input.mediaType }), basename(audioPath));
  transcriptionBody.append("model_id", sttModel);
  transcriptionBody.append("file_format", input.fileFormat);
  transcriptionBody.append("language_code", "en");

  const transcriptionResponse = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: transcriptionBody,
  });
  if (!transcriptionResponse.ok) {
    throw new Error(`ElevenLabs STT failed (${transcriptionResponse.status}): ${await transcriptionResponse.text()}`);
  }

  const transcription: unknown = await transcriptionResponse.json();
  if (
    typeof transcription !== "object" ||
    transcription === null ||
    !("text" in transcription) ||
    !("language_code" in transcription) ||
    !("language_probability" in transcription) ||
    typeof transcription.text !== "string" ||
    typeof transcription.language_code !== "string" ||
    typeof transcription.language_probability !== "number"
  ) {
    throw new Error("ElevenLabs STT returned an unexpected response");
  }

  const endpoint = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`);
  endpoint.searchParams.set("output_format", outputFormat);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "xi-api-key": apiKey },
    body: JSON.stringify({ text: guidance, model_id: ttsModel }),
  });
  if (!response.ok) {
    throw new Error(`ElevenLabs TTS failed (${response.status}): ${await response.text()}`);
  }

  const synthesizedAudio = await response.arrayBuffer();
  if (synthesizedAudio.byteLength === 0) {
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
    transcription: {
      model: sttModel,
      text: transcription.text,
      languageCode: transcription.language_code,
      languageProbability: transcription.language_probability,
    },
    tts: {
      text: guidance,
      model: ttsModel,
      outputFormat,
      contentType: response.headers.get("content-type") ?? "unknown",
      byteLength: synthesizedAudio.byteLength,
    },
    characterLimit,
    characterCount,
  };
}

async function main(): Promise<void> {
  const usageLimitUsd = Number(required("PROVIDER_CHECK_MAX_COST_USD"));
  if (!Number.isFinite(usageLimitUsd) || usageLimitUsd <= 0) {
    throw new Error("PROVIDER_CHECK_MAX_COST_USD must be a positive number");
  }
  const audioPath = optionalPath("PROVIDER_CHECK_AUDIO_PATH");
  const speechToTextInput = await readSpeechToTextAudio(audioPath);

  const gemini = await checkGemini();
  const result: ProviderCheckResult = {
    gemini,
    elevenLabs: await checkElevenLabs(
      audioPath,
      speechToTextInput,
      guidanceFor(gemini.secondObservation),
    ),
    usageLimitUsd,
  };

  console.log(JSON.stringify(result, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
