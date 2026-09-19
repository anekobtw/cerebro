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
  name: config.name ?? "Cerebro",
  slug: config.slug ?? "cerebro",
  extra: {
    ...config.extra,
    provider: {
      geminiSceneModel: process.env.GEMINI_SCENE_MODEL,
      geminiApiKey: process.env.GEMINI_API_KEY,
      geminiLiveModel: process.env.GEMINI_MODEL,
      elevenLabsApiKey: process.env.ELEVENLABS_API_KEY,
      elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID,
      elevenLabsTtsModelId: process.env.ELEVENLABS_TTS_MODEL_ID,
      elevenLabsTtsOutputFormat: process.env.ELEVENLABS_TTS_OUTPUT_FORMAT,
      elevenLabsSttModelId: process.env.ELEVENLABS_STT_MODEL_ID,
      elevenLabsRealtimeSttModelId: process.env.ELEVENLABS_REALTIME_STT_MODEL_ID,
      googleRoutesEnabled: process.env.GOOGLE_ROUTES_ENABLED,
      googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY,
      googleMapsRequestTimeoutMs: process.env.GOOGLE_MAPS_REQUEST_TIMEOUT_MS,
      googlePlacesEnabled: process.env.GOOGLE_PLACES_ENABLED,
      googlePlacesSearchRadiusM: process.env.GOOGLE_PLACES_SEARCH_RADIUS_M,
      googlePlacesRegionCode: process.env.GOOGLE_PLACES_REGION,
      navArrivalRadiusM: process.env.NAV_ARRIVAL_RADIUS_M,
      navMaxReroutesPerSession: process.env.NAV_MAX_REROUTES_PER_SESSION,
      navRerouteCooldownMs: process.env.NAV_REROUTE_COOLDOWN_MS,
    },
  },
});
