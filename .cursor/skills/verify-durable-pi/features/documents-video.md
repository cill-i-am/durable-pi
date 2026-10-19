# Documents, video, and automatic preparation

Send a PDF or video before processing finishes and let the original request resume when its readable material is ready.

## Sub-features

- `documents-pdf`: Extract page-labeled PDF text and disclose missing/truncated coverage.
- `documents-video`: Prepare timestamped frames and supported embedded text captions from MP4/WebM.
- `documents-wait`: Persist the original queued request while its files prepare across surfaces.
- `documents-fail`: Report a concrete preparation error before submitting incomplete input to the model.
- `documents-cancel`: Keep cancellation, archive, and Trash changes authoritative while jobs settle.
- `documents-retry`: Retry a failed preparation explicitly without creating new work on every status read.

## How to get to it (user POV)

- Upload through Files or the composer, attach, and send. Email uses the same preparation behavior. WhatsApp can export selected files but does not yet admit inbound PDFs/videos.
- Inspect **Preparing files…** and its **Cancel** action on a waiting request.
- Open the file's Preview to inspect extracted PDF text or the video frames/captions supplied to the model. Use its explicit retry control after a failure.

## Driving it with the verification harness

Preconditions: Use a valid small text PDF, a deliberately malformed PDF, and a small supported video. The fixture's pending PDF is synthetic.

- **Pending UI.** Run `pnpm test:browser tests/browser/workspace.spec.ts --grep 'send a PDF'`. Sending remains possible before extraction; waiting state survives reload.
- **Pipeline checks.** Run `pnpm test tests/attachment-preparation.test.ts` and `pnpm test:communication-runtime`. Native checks cover original admission, cancellation, and processing/restart boundaries; they are not live email acceptance.
- **Real file journey.** Send a PDF containing a unique sentence; verify the answer quotes the actual text and can return the unchanged original. Send a malformed PDF and verify the concrete error without an invented answer.
- **Video journey.** Open its prepared preview, inspect timestamps and available captions, then ask about a visible sampled frame. Compare the response with the preview.
- **Proof.** Keep the original request ID, processing state, extracted material, response, and original-file byte comparison.

## Gotchas

- No scanned-PDF OCR, image-subtitle OCR, or native video inference is provided.
- Video is limited to 8 MiB, ten minutes, 4096 pixels per side, and six sampled frames. Events between frames can be missed.
- Video audio is not transcribed. Supported text captions are bounded; damaged/complex files can fail decoding.
- Existing binary documents can remain stored-only. Storage and export do not imply successful content extraction.
