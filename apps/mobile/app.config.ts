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
      geminiSceneModel:
        process.env.EXPO_PUBLIC_GEMINI_SCENE_MODEL ?? process.env.GEMINI_SCENE_MODEL,
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
      elevenLabsRealtimeSttModelId:
        process.env.EXPO_PUBLIC_ELEVENLABS_REALTIME_STT_MODEL_ID ??
        process.env.ELEVENLABS_REALTIME_STT_MODEL_ID,
      googleRoutesEnabled:
        process.env.EXPO_PUBLIC_GOOGLE_ROUTES_ENABLED ??
        process.env.GOOGLE_ROUTES_ENABLED,
      googleMapsApiKey:
        process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY ??
        process.env.GOOGLE_MAPS_API_KEY,
      googleMapsRequestTimeoutMs:
        process.env.EXPO_PUBLIC_GOOGLE_MAPS_REQUEST_TIMEOUT_MS ??
        process.env.GOOGLE_MAPS_REQUEST_TIMEOUT_MS,
      googlePlacesEnabled:
        process.env.EXPO_PUBLIC_GOOGLE_PLACES_ENABLED ??
        process.env.GOOGLE_PLACES_ENABLED,
      googlePlacesSearchRadiusM:
        process.env.EXPO_PUBLIC_GOOGLE_PLACES_SEARCH_RADIUS_M ??
        process.env.GOOGLE_PLACES_SEARCH_RADIUS_M,
      googlePlacesRegionCode:
        process.env.EXPO_PUBLIC_GOOGLE_PLACES_REGION ??
        process.env.GOOGLE_PLACES_REGION,
      navArrivalRadiusM:
        process.env.EXPO_PUBLIC_NAV_ARRIVAL_RADIUS_M ??
        process.env.NAV_ARRIVAL_RADIUS_M,
      navMaxReroutesPerSession:
        process.env.EXPO_PUBLIC_NAV_MAX_REROUTES_PER_SESSION ??
        process.env.NAV_MAX_REROUTES_PER_SESSION,
      navRerouteCooldownMs:
        process.env.EXPO_PUBLIC_NAV_REROUTE_COOLDOWN_MS ??
        process.env.NAV_REROUTE_COOLDOWN_MS,
    },
  },
});
