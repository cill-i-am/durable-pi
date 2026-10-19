# Feature-map creation proof

Date: October 19, 2026. Product source baseline: `a133e4b93452694bf5d5aef0f3129ac4f662073e`.

This record distinguishes documentation/source coverage from executed acceptance. The map contains 27 feature areas and 155 behavior IDs. Each has a user journey, but map creation does not rerun every journey.

## Executed checks

- **Build: passed.** `pnpm build` completed for the browser and server production bundles.
- **Generated recipe: passed.** `pnpm test:browser tests/browser/workspace.spec.ts --project=desktop --grep 'sign in, open an agent' --trace on --output /private/tmp/pi-feature-map-evidence-19oct` completed one desktop journey in 6.6 seconds.
- **Doctor: passed within that journey.** The real UI showed Welcome back, rejected an incorrect fixture password, accepted the disposable fixture account, opened Your agents → Navi, and enabled Message Navi.
- **Drive: passed.** The journey attached a PNG, sent the message, observed Fixture reply received, checked the rendered image and download link, then reloaded and checked the same answer/download again. Its request guard rejected traffic outside the local fixture origin.
- **Cleanup: passed.** The Playwright command exited successfully. A subsequent `lsof -nP -iTCP:4399 -sTCP:LISTEN` returned no listener. The trace still existed after cleanup.
- **Evidence: retained locally.** Trace: `/private/tmp/pi-feature-map-evidence-19oct/workspace-sign-in-open-an--b33df-fixture-reply-and-reload-it-desktop/trace.zip`, 1,763,752 bytes, SHA-256 `b87f9e11f1dff2edb1b6857d9e98c90c8e376ab29f458a2ee4ea62c220176984`. It includes DOM/action evidence and screencast frames. The final UI frame was extracted as `/private/tmp/pi-feature-map-evidence-19oct/verified-ui.jpg` and inspected. These temporary local artifacts are not shipped in Git.
- **Map integrity: passed.** All 27 feature files use the required four sections and preconditions, all 155 behavior IDs are unique, index entries match sibling files, and referenced local files/test paths exist.
- **Formatting: passed.** Oxfmt checked the documentation and generated skill directory.

The first attempted invocation used an unsupported `--screenshot` CLI flag and exited before launching a fixture. The generated command was corrected to use `--trace on`, then rerun successfully. Separate failure screenshots retain the existing config's behavior. No live provider or production account was mutated.

## Stand-in boundaries

The browser fixture builds the actual frontend and drives its sign-in, collection, composer, image attachment, saved response/download, and reload controls. Its auth, model, file storage, and API state are synthetic/in-memory. It supplies a seeded Navi agent and a deterministic reply. Production does not supply these fixture credentials or responses.

A passing fixture run does not establish production auth/membership, a real ChatGPT answer, persistence after server-process loss, Cloudflare image/audio/PDF/video services, MIME delivery, or real WhatsApp acceptance. The feature-specific recipes and existing native/provider checks cover those separate boundaries when run with their prerequisites.

## Coverage not claimed in this pass

All other feature recipes are source-reviewed and **not run** in this documentation pass unless a later entry below explicitly records them. Live WhatsApp acceptance is **blocked** by deliberately parked provider onboarding. Real-device passkey behavior needs the account holder's device and is not established by a virtual authenticator.
