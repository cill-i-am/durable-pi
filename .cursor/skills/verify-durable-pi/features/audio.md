# Voice notes and audio transcription

Record or upload a voice note, review its saved transcript, and receive an ordinary text answer.

## Sub-features

- `audio-record`: Record, finish for review, or cancel microphone capture in the browser.
- `audio-upload`: Import supported audio from web, email, or WhatsApp.
- `audio-transcribe`: Preserve the private original and prepare a multilingual transcript.
- `audio-playback`: Play the original and inspect transcript metadata after reload.
- `audio-answer`: Send the transcript to the agent's configured conversation model and return text.

## How to get to it (user POV)

- In web chat, select **Record voice message**, then **Finish voice message** or **Cancel voice recording**.
- Review the attached recording before **Send message**. Upload an audio file through the normal file picker instead if preferred.
- Play a saved audio attachment with **Play FILE_NAME**. Send a voice note through a configured WhatsApp connection or attach audio to an accepted email.

## Driving it with the verification harness

Preconditions: Browser recording requires microphone permission and an appropriate secure context. The browser test provides a synthetic audio stream.

- **Recording journey.** Run `pnpm test:browser tests/browser/audio.spec.ts --project=desktop`. Finishing attaches the recording, sending returns text, and original playback remains after reload.
- **Cancel.** The same spec cancels a pending microphone prompt and verifies that a late stream is closed without upload.
- **Transcription checks.** Run `pnpm test tests/workspace-audio.test.ts` for pipeline and transcript boundaries.
- **Real provider acceptance.** Upload a short recording, inspect its transcript, send it, then compare the answer with the spoken request. For WhatsApp, record the exact provider message only after onboarding is complete.
- **Proof.** Preserve the original recording reference, transcript, text answer, and microphone-stop result. Do not label synthetic audio tests as transcription-provider acceptance.

## Gotchas

- Transcription uses Cloudflare Workers AI Whisper large v3 turbo. The usual configured agent model answers the transcript.
- Voice notes receive text replies. Speech generation and real-time calls are not implemented.
- Originals retain the 8 MiB file limit. Transcription is bounded to ten minutes and 32,000 characters and has separate Workers AI usage.
- Video preparation does not transcribe a video's audio track.
