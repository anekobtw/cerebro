import Constants from "expo-constants";

function required(value: string | undefined, variableName: string): string {
  if (!value) {
    throw new Error(
      `${variableName} must be configured before starting a provider session`,
    );
  }

  return value;
}

interface ProviderExtra {
  geminiSceneModel?: string;
  geminiApiKey?: string;
  elevenLabsApiKey?: string;
  elevenLabsVoiceId?: string;
  elevenLabsTtsModelId?: string;
  elevenLabsTtsOutputFormat?: string;
  elevenLabsRealtimeSttModelId?: string;
}

const providerExtra = (Constants.expoConfig?.extra?.provider ??
  {}) as ProviderExtra;

export const providerConfig = {
  get geminiSceneModel() {
    return (providerExtra.geminiSceneModel ?? "gemini-3.6-flash")
      .trim()
      .replace(/^models\//, "");
  },
  get geminiApiKey() {
    return required(providerExtra.geminiApiKey, "GEMINI_API_KEY");
  },
  get elevenLabsApiKey() {
    return required(providerExtra.elevenLabsApiKey, "ELEVENLABS_API_KEY");
  },
  get elevenLabsVoiceId() {
    return required(providerExtra.elevenLabsVoiceId, "ELEVENLABS_VOICE_ID");
  },
  get elevenLabsTtsModelId() {
    return required(
      providerExtra.elevenLabsTtsModelId,
      "ELEVENLABS_TTS_MODEL_ID",
    );
  },
  get elevenLabsTtsOutputFormat() {
    return required(
      providerExtra.elevenLabsTtsOutputFormat,
      "ELEVENLABS_TTS_OUTPUT_FORMAT",
    );
  },
  get elevenLabsRealtimeSttModelId() {
    return providerExtra.elevenLabsRealtimeSttModelId ?? "scribe_v2_realtime";
  },
} as const;
