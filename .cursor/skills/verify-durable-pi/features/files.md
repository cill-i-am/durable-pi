# Private files and images

Upload, inspect, attach, download, and share original files from an agent's private workspace.

## Sub-features

- `files-library`: Upload, rename, preview, download, move to Trash, and restore files.
- `files-attach`: Select up to four files for a message or supported steering input.
- `files-images`: Keep the original image and prepare bounded model/preview images.
- `files-read`: Let the agent list files, read supported text ranges, and inspect saved images.
- `files-share`: Select existing workspace files for an answer through `share_file` or `share_image`.
- `files-transfer`: Exchange saved files with the isolated terminal workspace.

## How to get to it (user POV)

- Open `/agents/AGENT_SLUG/files`, the composer **Attach files**, or **Upload files** in Files.
- Select a file for Preview/source/download controls. Use the file collection's Trash view to restore it.
- Ask the agent to inspect an attached image or return a specific workspace file.
- Use Terminal → File transfer for Linux workspace imports and exports.

## Driving it with the verification harness

Preconditions: Use a small nonprivate PNG and text file. The existing fixture supports an image upload and reply-file download.

- **Upload and return.** Run `pnpm test:browser tests/browser/workspace.spec.ts --project=desktop --grep 'sign in, open an agent'`. The image appears in the draft, the answer exposes **Download fixture-photo.png**, and both survive reload.
- **Library lifecycle.** On the real app, upload the two test files, rename one, reopen its details, move it to Trash, then restore it. Download and compare original bytes.
- **Agent selection.** Ask the agent to inspect the image and return the original. Inspect `view_image` and a completed share tool, then follow the answer's download link.
- **Checks.** Run `pnpm test tests/workspace-files.test.ts tests/workspace-images.test.ts tests/workspace-tools.test.ts`.
- **Proof.** Keep action traces, reopened metadata, and byte/hash comparison for downloads. A selected share tool does not prove channel delivery.

## Gotchas

- The collection is flat; file paths do not create folders or sharing boundaries.
- Input files are limited to four per request and 8 MiB each, subject to supported formats and workspace quota.
- `share_file` defaults to Allow across surfaces; explicit per-agent tool policies still apply.
- No public bucket or anonymous download URL is created. [Documents](documents-video.md) and [audio](audio.md) have separate preparation limits.
