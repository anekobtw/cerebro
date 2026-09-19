import "dotenv/config";
import { z } from "zod";

const environmentSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  PROVIDER_MODE: z.enum(["mock", "gemini_text_elevenlabs", "gemini_native"]).default("mock"),
});

export const config = environmentSchema.parse(process.env);
