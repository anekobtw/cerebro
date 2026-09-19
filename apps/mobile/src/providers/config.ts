function required(value: string | undefined, variableName: string): string {
  if (!value) {
    throw new Error(`${variableName} must be configured before starting a provider session`);
  }

  return value;
}

export const providerConfig = {
  get geminiApiKey() {
    return required(process.env.EXPO_PUBLIC_GEMINI_API_KEY, "EXPO_PUBLIC_GEMINI_API_KEY");
  },
  get geminiLiveModel() {
    return required(process.env.EXPO_PUBLIC_GEMINI_LIVE_MODEL, "EXPO_PUBLIC_GEMINI_LIVE_MODEL");
  },
  get elevenLabsApiKey() {
    return required(process.env.EXPO_PUBLIC_ELEVENLABS_API_KEY, "EXPO_PUBLIC_ELEVENLABS_API_KEY");
  },
  get elevenLabsVoiceId() {
    return required(process.env.EXPO_PUBLIC_ELEVENLABS_VOICE_ID, "EXPO_PUBLIC_ELEVENLABS_VOICE_ID");
  },
  get elevenLabsTtsModelId() {
    return required(
      process.env.EXPO_PUBLIC_ELEVENLABS_TTS_MODEL_ID,
      "EXPO_PUBLIC_ELEVENLABS_TTS_MODEL_ID",
    );
  },
  get elevenLabsTtsOutputFormat() {
    return required(
      process.env.EXPO_PUBLIC_ELEVENLABS_TTS_OUTPUT_FORMAT,
      "EXPO_PUBLIC_ELEVENLABS_TTS_OUTPUT_FORMAT",
    );
  },
  get elevenLabsSttModelId() {
    return required(
      process.env.EXPO_PUBLIC_ELEVENLABS_STT_MODEL_ID,
      "EXPO_PUBLIC_ELEVENLABS_STT_MODEL_ID",
    );
  },
} as const;
