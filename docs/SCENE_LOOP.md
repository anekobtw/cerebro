# Destination and scene loop

ElevenLabs Scribe recognizes speech. ElevenLabs TTS speaks the answers. Gemini receives camera images and returns JSON with a description and an instruction. EXPO_PUBLIC_GEMINI_SCENE_MODEL defaults to gemini-3.6-flash.

The assistant asks for a destination and says "The route is built." This is a placeholder. It makes no route requests and does not start location tracking.

Only complete transcripts of "pause", "repeat", and "end assistant" trigger commands. Capitalization and sentence punctuation do not matter. Say "pause" again to resume. Say "repeat" to cancel capture and speech, clear the destination, and hear the destination question again. Capture stays stopped until a new destination is received and the placeholder announcement finishes. After the destination, other speech does not interrupt guidance or go to Gemini.

Capture waits for speech playback to finish. The first frame goes to Gemini. Later frames are decoded locally into a 32 by 32 grid. An upload requires at least 18 percent of cells to change by 24 RGB levels on average relative to the last described image. These thresholds need field tuning for hand movement and lighting. Failed requests retry without accepting a new baseline.

## Phone checks

- Check the destination prompt and placeholder announcement.
- Keep the view unchanged and confirm the upload count stays fixed. Change the view and confirm one short answer plays.
- Try each voice command during playback and while idle. Check pause followed by pause to resume.
- Try unrelated speech and confirm it has no effect.
- Check denied microphone permission, provider disconnection, and failed TTS.
- Compare the phone speaker with headphones. Speaker echo can affect command recognition.
