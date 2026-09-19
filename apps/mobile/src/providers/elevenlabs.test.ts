import { describe, expect, it } from "vitest";

import { transcribeAudio } from "./elevenlabs-stt";
import { synthesizeSpeech } from "./elevenlabs-tts";

describe("direct ElevenLabs clients", () => {
  it("rejects empty speech before sending a provider request", async () => {
    await expect(synthesizeSpeech("   ")).rejects.toThrow("Speech text cannot be empty");
  });

  it("rejects an empty audio upload before sending a provider request", async () => {
    await expect(
      transcribeAudio({
        audio: new Blob(),
        fileName: "empty.pcm",
      }),
    ).rejects.toThrow("Audio cannot be empty");
  });
});
