import { z } from "zod";

export const providerModeSchema = z.enum([
  "mock",
  "gemini_text_elevenlabs",
  "gemini_native",
]);

export type ProviderMode = z.infer<typeof providerModeSchema>;

export const PROTOCOL_VERSION = 1 as const;
