import Constants from "expo-constants";

function required(value: string | undefined, variableName: string): string {
  if (!value) {
    throw new Error(`${variableName} must be configured before starting a provider session`);
  }

  return value;
}

interface ProviderExtra {
  geminiApiKey?: string;
  geminiLiveModel?: string;
  elevenLabsApiKey?: string;
  elevenLabsVoiceId?: string;
  elevenLabsTtsModelId?: string;
  elevenLabsTtsOutputFormat?: string;
  elevenLabsSttModelId?: string;
  googleRoutesEnabled?: string;
  googleMapsApiKey?: string;
  googleMapsRequestTimeoutMs?: string;
}

const providerExtra = (Constants.expoConfig?.extra?.provider ?? {}) as ProviderExtra;

export const providerConfig = {
  get geminiApiKey() {
    return required(
      process.env.EXPO_PUBLIC_GEMINI_API_KEY ?? providerExtra.geminiApiKey,
      "GEMINI_API_KEY or EXPO_PUBLIC_GEMINI_API_KEY",
    );
  },
  get geminiLiveModel() {
    return required(
      process.env.EXPO_PUBLIC_GEMINI_LIVE_MODEL ?? providerExtra.geminiLiveModel,
      "GEMINI_MODEL or EXPO_PUBLIC_GEMINI_LIVE_MODEL",
    );
  },
  get elevenLabsApiKey() {
    return required(
      process.env.EXPO_PUBLIC_ELEVENLABS_API_KEY ?? providerExtra.elevenLabsApiKey,
      "ELEVENLABS_API_KEY or EXPO_PUBLIC_ELEVENLABS_API_KEY",
    );
  },
  get elevenLabsVoiceId() {
    return required(
      process.env.EXPO_PUBLIC_ELEVENLABS_VOICE_ID ?? providerExtra.elevenLabsVoiceId,
      "ELEVENLABS_VOICE_ID or EXPO_PUBLIC_ELEVENLABS_VOICE_ID",
    );
  },
  get elevenLabsTtsModelId() {
    return required(
      process.env.EXPO_PUBLIC_ELEVENLABS_TTS_MODEL_ID ??
        providerExtra.elevenLabsTtsModelId,
      "ELEVENLABS_TTS_MODEL_ID or EXPO_PUBLIC_ELEVENLABS_TTS_MODEL_ID",
    );
  },
  get elevenLabsTtsOutputFormat() {
    return required(
      process.env.EXPO_PUBLIC_ELEVENLABS_TTS_OUTPUT_FORMAT ??
        providerExtra.elevenLabsTtsOutputFormat,
      "ELEVENLABS_TTS_OUTPUT_FORMAT or EXPO_PUBLIC_ELEVENLABS_TTS_OUTPUT_FORMAT",
    );
  },
  get elevenLabsSttModelId() {
    return required(
      process.env.EXPO_PUBLIC_ELEVENLABS_STT_MODEL_ID ??
        providerExtra.elevenLabsSttModelId,
      "ELEVENLABS_STT_MODEL_ID or EXPO_PUBLIC_ELEVENLABS_STT_MODEL_ID",
    );
  },
  get googleRoutesEnabled() {
    const value =
      process.env.EXPO_PUBLIC_GOOGLE_ROUTES_ENABLED ??
      providerExtra.googleRoutesEnabled ??
      "false";
    return value.toLowerCase() === "true";
  },
  get googleMapsApiKey() {
    return (
      process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY ??
      providerExtra.googleMapsApiKey
    );
  },
  get googleMapsRequestTimeoutMs() {
    const raw =
      process.env.EXPO_PUBLIC_GOOGLE_MAPS_REQUEST_TIMEOUT_MS ??
      providerExtra.googleMapsRequestTimeoutMs ??
      "5000";
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 5_000;
  },
} as const;
