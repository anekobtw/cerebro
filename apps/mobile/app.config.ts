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
  extra: {
    ...config.extra,
    provider: {
      geminiApiKey:
        process.env.EXPO_PUBLIC_GEMINI_API_KEY ?? process.env.GEMINI_API_KEY,
      geminiLiveModel:
        process.env.EXPO_PUBLIC_GEMINI_LIVE_MODEL ?? process.env.GEMINI_MODEL,
      elevenLabsApiKey:
        process.env.EXPO_PUBLIC_ELEVENLABS_API_KEY ?? process.env.ELEVENLABS_API_KEY,
      elevenLabsVoiceId:
        process.env.EXPO_PUBLIC_ELEVENLABS_VOICE_ID ?? process.env.ELEVENLABS_VOICE_ID,
      elevenLabsTtsModelId:
        process.env.EXPO_PUBLIC_ELEVENLABS_TTS_MODEL_ID ??
        process.env.ELEVENLABS_TTS_MODEL_ID,
      elevenLabsTtsOutputFormat:
        process.env.EXPO_PUBLIC_ELEVENLABS_TTS_OUTPUT_FORMAT ??
        process.env.ELEVENLABS_TTS_OUTPUT_FORMAT,
      elevenLabsSttModelId:
        process.env.EXPO_PUBLIC_ELEVENLABS_STT_MODEL_ID ??
        process.env.ELEVENLABS_STT_MODEL_ID,
    },
  },
});
