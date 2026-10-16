# One startup view

Production investigation on 16 October 2026 confirmed three distinct layouts: session (Pi mark and short bar), catalog (workspace-opening bar), and conversation (two bars inside the chat). A throttled live observation switched at 3.84 and 4.06 seconds, then showed conversation content at 5.13 seconds.

`WorkspaceStartup` provides one public, noninteractive chat-shaped placeholder for session checking, lazy sign-in loading, and initial workspace data. Authenticated catalog and conversation hooks still run in parallel. The workspace reveals when its catalog and initial conversation state are available, or when a failure can be presented. Collections and the agent editor do not wait for conversation data. Empty conversations are ready states.

The completed-startup flag belongs to the existing owner-keyed workspace. Later reconnects, retries and agent navigation retain their existing local controls and do not return to a full-page startup view. No backend service, Effect runtime, authority cache or persisted state is added. Server admission, native Pi storage and stream cleanup are unchanged. The Skeleton primitive and existing theme tokens supply the appearance; decorative shapes are hidden from assistive technology, with one loading status and no input targets.

## Verification

Five alternating local runs per condition use the same styled UI, mobile viewport and delayed-metadata transport. All five baselines show session → catalog → conversation → chat; all five candidates show startup → chat, with one set of placeholder bounds and no interactive controls during startup. All retain twenty responses without horizontal overflow. Readiness medians are 2,649.0 → 2,636.5 ms. The loopback server deliberately holds metadata for 2.2 seconds; these numbers are a race/visual check, not a production speed claim. Numeric samples and exclusions are in [unified-startup-measurements.json](unified-startup-measurements.json).

Browser checks also cover signed-out sign-in, catalog failure, conversation failure and successful Reconnect, empty history, delayed catalog, delayed metadata and the agent collection route. Reconnect retained the input node and all twenty responses without reintroducing the full-page loader.

Dark-mode/reduced-motion checks confirm all seven placeholder shapes stop animating, the view exposes a busy status without focus targets, and the mobile viewport has no horizontal overflow. Full verification passes: TypeScript, 1,540 tests in 154 files, seventeen native runtime gates, website and four Worker builds. Lint has zero errors and the existing test shadow warning.

The fixture supports `PERF_CASE=anonymous`, `catalog-error`, `conversation-error`, `empty`, `catalog-slow`, and `metadata-slow`. Build once with `node scripts/performance/server.mjs --build-only`, then serve a case with `PERF_CASE=metadata-slow node scripts/performance/server.mjs 4398 --serve-only`. Its endpoints are synthetic, loopback-only and read-only.

## Fixture correction

Screenshot verification exposed incomplete utility CSS in the fixture: Tailwind's automatic scan did not include the application source under the fixture's separate Vite root. Its stylesheet now explicitly registers the real source directory. The correction was applied to both archived baseline and candidate before accepting the comparison above. Earlier fixture timings and the first unstyled cohort from this investigation are excluded from visual/performance conclusions. Previously recorded production reloads are independent of this fixture and remain valid.
