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
  googleRoutesEnabled?: string;
  googleMapsApiKey?: string;
  googleMapsRequestTimeoutMs?: string;
  googlePlacesEnabled?: string;
  googlePlacesSearchRadiusM?: string;
  googlePlacesRegionCode?: string;
  navArrivalRadiusM?: string;
  navMaxReroutesPerSession?: string;
  navRerouteCooldownMs?: string;
}

function booleanSetting(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return raw.trim().toLowerCase() === "true";
}

function numberSetting(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
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
  get googleRoutesEnabled() {
    return booleanSetting(providerExtra.googleRoutesEnabled, false);
  },
  get googlePlacesEnabled() {
    return booleanSetting(providerExtra.googlePlacesEnabled, false);
  },
  get googlePlacesSearchRadiusM() {
    return numberSetting(providerExtra.googlePlacesSearchRadiusM, 3_000);
  },
  get googlePlacesRegionCode(): string | undefined {
    const value = providerExtra.googlePlacesRegionCode?.trim();
    return value ? value.toLowerCase() : undefined;
  },
  get navArrivalRadiusM() {
    return numberSetting(providerExtra.navArrivalRadiusM, 30);
  },
  get navMaxReroutesPerSession() {
    return numberSetting(providerExtra.navMaxReroutesPerSession, 3);
  },
  get navRerouteCooldownMs() {
    return numberSetting(providerExtra.navRerouteCooldownMs, 30_000);
  },
  get googleMapsApiKey() {
    return providerExtra.googleMapsApiKey;
  },
  get googleMapsRequestTimeoutMs() {
    return numberSetting(providerExtra.googleMapsRequestTimeoutMs, 5_000);
  },
} as const;
