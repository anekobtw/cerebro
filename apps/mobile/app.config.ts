import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import type { ConfigContext, ExpoConfig } from "expo/config";

const repositoryEnvPath = resolve(__dirname, "../../.env");

if (existsSync(repositoryEnvPath)) {
  loadEnvFile(repositoryEnvPath);
}

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: config.name ?? "Blind Maps",
  slug: config.slug ?? "blind-maps",
  extra: {
    ...config.extra,
    provider: {
      geminiSceneModel: process.env.GEMINI_SCENE_MODEL,
      geminiApiKey: process.env.GEMINI_API_KEY,
      elevenLabsApiKey: process.env.ELEVENLABS_API_KEY,
      elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID,
      elevenLabsTtsModelId: process.env.ELEVENLABS_TTS_MODEL_ID,
      elevenLabsTtsOutputFormat: process.env.ELEVENLABS_TTS_OUTPUT_FORMAT,
      elevenLabsRealtimeSttModelId: process.env.ELEVENLABS_REALTIME_STT_MODEL_ID,
    },
  },
});
