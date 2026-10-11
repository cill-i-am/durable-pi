# Durable Pi — build tracker

Started 2026-10-10. Delivery owner: Codex. Status: **slices 01–04a deployed; tool permissions and durable approvals verified locally**.

## Outcome

A private workspace at `bot.cill-i-am.com` where each bot has durable conversations, memory, files, reusable skills, scoped tools, a browser, execution environments, generated apps, and routines that continue when the web app is closed. The approved Paper design is the visual reference. The whole application and execution infrastructure runs on Cloudflare. Model requests continue using the owner's existing OpenAI connection; that inference remains external to Cloudflare.

Build and verify one complete user journey at a time. A checked slice means its UI, authorization, persistence, recovery, and relevant tests work together. Distinguish local proof, review, CI, and hosted proof. Do not mark mockups, placeholder controls, or untested cloud bindings as shipped.

## Architecture and domain ownership

Backend uses bounded contexts with pure domain values, Effect application workflows, feature-owned persistence, and adapters at the host. Start flat and add internal folders when complexity warrants them. Avoid a global service/repository layer or one interface per function.

| Context | Owns | Integration contract |
| --- | --- | --- |
| Identity | Owner login, sessions, setup and canonical origin | Authenticated owner identity; never browser-supplied owner IDs |
| Agents | Bot identity, instructions, lifecycle and owner catalog | Validated active bot reference; legacy bot retains its original object ID |
| Conversations | Turn admission, Pi sessions, steering, cancellation, delegation and event projection | Durable operation IDs and committed turn events |
| Memory | Immutable archive, summary tree, notes, search and recovery | Existing Effect memory repository; isolated per bot |
| Workspace | Files, attachments, revisions and skill documents | Validated paths and private asset references |
| Access | Tool grants, approvals, connection references and execution budgets | Permit/deny/approval decisions enforced before effects |
| Execution | Browser sessions, terminal sessions, containers and bounded code execution | Durable operation receipts and session handles |
| Apps | Generated application versions, publication and interaction events | Isolated application runtime and explicit sharing policy |
| Routines | Scheduled work, webhooks, triggers, deduplication and pause | Authorized work admitted to Conversations |
| Activity | User-visible operations and actionable recovery | Projections of committed domain events; no secrets |

Frontend uses `src/features/<capability>` with a small public entrypoint, feature-local queries/forms/components, and shared shadcn primitives in `src/components/ui`. Routes compose features. Feature code does not import other features' internals. Transport contracts belong to the capability that owns them. Backend domain/application code must not import Cloudflare or React.

Keep the existing PersonalAgent namespace, memory tables, AuthDatabase, MemoryBackups bucket, production hostname, and encrypted deployment state. The original owner chat becomes the default bot without copying/deleting history. Multiple bots share a single account-level credential refresh owner; rotating an OAuth refresh token independently in several objects is forbidden. No credentials, conversations, local auth state, or private assets enter GitHub.

Visual thesis: a quiet, warm workroom with compact navigation, readable conversation, and a contextual workbench. Composition: bot sidebar → conversation → optional workbench. Interactions: keyboard-first menus, restrained pane transitions, clear running/approval/recovery states; respect reduced motion. Semantic tokens own colors, type, spacing, and radii for later retheming.

## Password recovery priority (2026-10-10)

The owner requested password recovery before continuing. Implemented Better Auth reset with Cloudflare Email, a 15-minute single-use token, session revocation, owner-only recipient/sender binding, strict same-origin requests, and database rate limits. The link uses a fragment so its token does not enter HTTP access logs or referrers. Forgot/reset forms use the same shadcn/Base UI primitives as login.

- Local workerd E2E passed: known/unknown accounts return identical responses; email is simulated locally; canonical token link; short-password rejection; concurrent token replay permits exactly one reset; expired links fail; old password/session stop working; new password works; request throttling and foreign origin/callback rejection.
- Cloudflare sending domain `notify.cill-i-am.com` was provisioned through the Cloudflare connector. DNS status is ready; SPF/DKIM/DMARC and bounce records are confined to this subdomain. Sent-message previews are disabled, and suppressed recipients produce errors.
- The Email binding is managed by the app's Alchemy stack. Sending-domain onboarding is account bootstrap, outside the app deployment stack; CI gains no zone-wide Email Sending permission. Changes to the sender require updating the binding allowlist and onboarding the corresponding domain.
- Backend review passed. Frontend review caught a replacement-link state bug; fragment-change handling now invalidates stale pending submissions.
- 51 tests, typecheck, lint, build and both reviews passed. Browser request confirmation, missing/replacement link states and a 390×844 layout were checked; no horizontal overflow.
- Delivered in PR #3, main `de4dedd`, production run `38093232390` succeeded. Hosted recovery form verified and an owner reset requested; Cloudflare reported successful sends. Inbox receipt and the owner choosing their password are not claimed. The user will review later; this is not a gate on subsequent implementation.

## End-to-end slices

| Slice | User outcome and acceptance criteria | Status |
| --- | --- | --- |
| 01 — Private multi-agent workspace | Sign in/out; create, rename, select and archive bots; existing history stays in the default bot; per-bot chat/memory isolation; refresh retains selection; usable sidebar on desktop/mobile; one credential refresh owner. | Deployed; owner model acceptance deferred |
| 02 — Live conversation control | Text/thinking/tool events stream with reconnect; steer at tool boundaries or queue a follow-up; stop/retry without duplicate turns; archive preserves delivery order; model/reasoning selection. | Deployed |
| 03 — Files and attachments | Upload images, videos and documents privately; validate size/type/path; preview/download/delete safely; reference assets in a turn; vision uses supported image blocks; video uses explicit frame/transcript extraction. | 03a–03b deployed; video preprocessing follows execution runtime |
| 04 — Reusable skills | Create/edit/attach skills to bots; durable revisions; selected skills enter context; import through the intended Executor source; scoped access and recovery. | 04a deployed; Executor import follows the connection slice |
| 05 — Tools and approvals | Connect Executor/MCP; assign tools per bot; Allow/Ask/Deny enforced server-side; approval persists across reload/restart; background work cannot bypass approval; revoke access. | 05a verified locally; external connections are 05b |
| 06 — Browser | Bot browses on Cloudflare; observe and take over in the workbench; authenticated Chromium sessions; Kitesurf for compatible short tasks; session expiry/reconnect and destination controls. | Planned |
| 07 — Execution and terminal | Isolated fast code execution plus on-demand Linux container; live terminal; files persist across container restarts; bounded time/output/network; cancel and recover. | Planned |
| 08 — Generated apps and inline UI | Bot creates, previews, updates and runs an app; versioned private publication; isolated execution/storage; inline UI uses a bounded renderer; interactions return events to the owning bot. | Planned |
| 09 — Routines and incoming events | Schedule/pause/delete routines; run with browser closed; authenticated webhook triggers; durable retry/deduplication; notify on meaningful outcomes; respect bot grants and budgets. | Planned |
| 10 — Delegation | Explicit parent/child tasks; separate child memory/tool grants; bounded concurrency; steer/stop children; deliver completed reports once after restart. | Planned |
| 11 — Activity and recovery | Per-bot/global activity; inspect tool outcomes and approvals; recover interrupted work; expose actionable connection/backup failures; inspect/export memory and workspace. | Planned |
| 12 — Complete product verification | Approved desktop/mobile states implemented; keyboard/accessibility checks; isolation/replay/permission tests; restore proof; secret scan; CI/deploy and hosted acceptance of all journeys. | Planned |

Each slice gets implementation and proof notes below. Add a slice rather than hiding missing behavior in “done.” `todo.md` remains the detailed OptChat steering/subagent reference; this tracker supersedes its deferral status.

## Acceptance journeys

1. Existing owner signs in, sees the original chat, creates another bot, and verifies neither chat nor memory crosses between them.
2. Give a bot an image/document, steer it during a tool run, approve a scoped action, and reopen the browser without losing progress.
3. Teach a skill, have the bot use its files/browser/terminal to build an app, interact with that app, and see the bot react to the resulting event.
4. Schedule a bounded monitoring task, close the app, return to the result, pause it, and verify further work stops.
5. Interrupt execution, reconnect, and verify a durable operation is neither lost nor repeated; restore private data into an isolated target.

## Verification and delivery

- Baseline: fetched `origin/main` at `32aeda8` (Effect-native memory refactor).
- Work branch: `codex/agent-workspace`; isolated worktree, preserving the user's existing checkout.
- Per slice: meaningful domain/adapter tests, typecheck, lint, build, relevant local workerd/browser E2E, source/secret review.
- Before shipping: inspect diff, run required CI, retain data and stable infrastructure IDs; hosted checks are separate evidence.
- Live model probes require an isolated credential or the single hosted refresh owner. Never run a copied production refresh token in local tests.
- Broad/new Cloudflare permissions or external account connections are tracked as explicit provisioning gates after implementation is reviewable. Existing authorization is retained.
- Current evidence: slice 01 deployed in PR #2, main `26629b4`, production run `38092294683` succeeded. Hosted unauthenticated boundary passed. Owner/model acceptance was deferred because the owner forgot their password.

## Decisions and known constraints

- Pi remains the agent harness. Cloudflare owns application hosting, state, storage, browsers, execution and scheduling; Alchemy Effect owns deployment.
- Generated code receives only scoped capabilities, never deployment credentials or the parent application's bindings by default.
- Browser Run Chromium is necessary for persistent authenticated sessions and human takeover. Kitesurf is an optional efficient backend, not a promise of full browser compatibility.
- `@cloudflare/shell` is currently a structured JavaScript/filesystem runtime. Full Linux requires Sandbox Containers. `@cloudflare/computer` is a useful reference but explicitly preview-only; evaluate compatibility in slice 07 before adoption.
- Video upload and video understanding are distinct: installed Pi supports text/image blocks; implement media preprocessing rather than claiming native video input.
- Existing OptChat archive/summary/cache behavior is a compatibility contract. Preserve it while integrating steers, assets and child runs.

## References

- [Approved Paper design — 32 states](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-1-0)
- [Fayaz's bot ecosystems reference](https://x.com/fayazara/status/2108535983750943062?s=20)
- [Per-bot permissions](https://x.com/fayazara/status/2108543232531685598)
- [Executor connections reference](https://x.com/fayazara/status/2108543443060621784)
- [OptChat specification](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449)
- [Pi on Cloudflare](https://developers.cloudflare.com/agents/harnesses/pi/)
- [Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/)
- [Sandbox environment selection](https://developers.cloudflare.com/sandbox/concepts/)
- [Cloudflare shell](https://github.com/cloudflare/agents/tree/main/packages/shell)
- [Cloudflare Computer preview](https://github.com/cloudflare/computer)
- [Kitesurf](https://developers.cloudflare.com/browser-run/kitesurf/)
- [Browser Live View](https://developers.cloudflare.com/browser-run/features/live-view/)
- [Durable scheduling](https://developers.cloudflare.com/agents/runtime/execution/schedule-tasks/)
- [shadcn Base UI sidebar](https://ui.shadcn.com/docs/components/base/sidebar)
- [Alchemy CI](https://alchemy.run/environments/ci/)
- Current Effect, Alchemy and TypeScript guidance read from **Personal Skills via Executor**, revision `cddabf4b664f6a24bd03a1b29bf4e47b6872e4a21bc0d51f029ffb8c8c441717`. Skills are not copied into the repository.

## Slice evidence log

### 01 — Private multi-agent workspace

Implemented owner catalog, per-bot routing and instructions, shared account credential refresh, archive/restore, and shadcn Base UI navigation. Preserved the original default object and all existing memory routes. Frontend split into auth, agents, conversation and memory features.

Proof (2026-10-10):
- 49 tests passed, including catalog creation/replay/capacity/restore, OAuth refresh coalescing, catalog response ordering and revisioned archive admission across restart.
- Local workerd protocol check passed: owner login/logout, bot CRUD and replay, input validation, CSRF, isolated memory search/import/export, missing/archived bot rejection and restore.
- Browser and Worker restart checks passed at desktop and 390×844: create/select/edit/archive/restore, sidebar behavior and scoped conversation. Synthetic account only; no production credential copied.
- Read-only backend/frontend reviews found and corrected refresh-on-read failure, archive admission race and stale catalog-response race.
- No new Cloudflare resource or permission required. Existing admitted work may finish after archival. An archived bot rejects newly admitted messages.
- Delivered in PR #2, main `26629b4`. CI and production deployment succeeded (run `38092294683`); hosted login boundary verified. Owner/model acceptance remains unverified and will be reviewed by the user later. Live model behavior is not claimed by the credential-free local check.

### 02a — Live conversation events (part of slice 02)

Replaced frequent chat polling with an authenticated SSE stream driven by Pi events. Every connection starts with a durable snapshot, then changed turns and metadata. Slow clients disconnect instead of retaining unbounded buffers. Connections renew after one minute to recheck authentication; HTTP polling covers interrupted streams without overwriting newer events.

The frontend renders ordered text, collapsible thinking, tool inputs/results and completed/interrupted states. Only display fields cross the HTTP boundary; provider replay signatures remain private. A single Pi snapshot supplies entries and partial text, avoiding duplicate output at commit. Disclosure IDs remain stable when partial output commits.

Proof (2026-10-11):
- 62 tests passed, including stream deltas/removal, cancellation, bounded buffers, late watcher cleanup, replay-data exclusion, stable disclosure identities and thinking/tool-only terminal states.
- Local workerd SSE authenticated snapshot/reconnect/logout check passed. Existing model tokens remain absent from the local stage.
- Read-only reviews identified and resolved hidden terminal status and disclosure remounting; follow-up review passed. Browser checks confirmed expanded thinking/tool details and failed/cancelled status using a synthetic local transcript. Typecheck, lint and production build passed. Delivered in PR #4, main `29b74f7`; production run `38093923092` succeeded.
- Mid-run steering, retry controls and model/reasoning selection are delivered separately in 02b.

### 02b — Steering, stop/retry and model controls

A reply owns its steering inputs; a queued follow-up starts a separate Pi session after memory settles. The conversation store durably records admission, parentage, model/reasoning choice and stop intent. A host restart replays the same native Pi operation IDs. Transcript archiving follows actual Pi placement, so a correction is archived between the tool result and its next answer. Unanswered inputs remain visible and can be retried explicitly.

The composer offers Steer/Queue while working, a durable Stop control and per-bot model/reasoning settings. Uncertain HTTP sends retain their original payload and ID even when live activity changes. Revisioned settings prevent a delayed event stream from reverting a model just saved through the menu. Settings apply to new replies; steers inherit their active reply's settings.

Proof (2026-10-11):
- 74 tests passed. Native Pi with its SQLite adapter and a deterministic provider verified tool-boundary steering, duplicate admission, shutdown/reopen during a pending tool and steer, transcript ordering, completed replay and cancellation with queued input withdrawal. No real model or credentials used.
- Adapter regressions cover snapshot/receipt ordering, final-output coverage, quiescence and stop before native submission. Store tests cover legacy migration, admission/finish races, durable stop, queue bounds and model snapshotting.
- Local workerd HTTP check passed: session/origin protection, model validation/persistence, missing bot/turn rejection, offline model boundary and idempotent stop.
- Browser verified model/reasoning changes, Steer/Queue copy and durable stopping of a synthetic pending correction. At 390×844 there was no horizontal overflow. Synthetic transcript fixtures are not live-model evidence.
- Backend review found and fixed archive-order and finalization races; frontend review found and fixed uncertain-send duplication and delayed-settings rollback. Follow-up reviews passed. Typecheck, lint and production build passed.
- No new cloud resource or permission. Delivered in PR #5, main `46b010f`; production run `38095052504` succeeded. Owner's hosted live-model acceptance remains deferred at their request.


### 03a — Private files and image/text attachments

Workspace owns private R2 originals, bounded JPEG model inputs, per-bot metadata, upload reservations, safe downloads, text-range reads, rename and recoverable Trash. A bot can list its files and read UTF-8 text with Pi tools. Attachments are selected from the composer or file library; image and text context is captured at turn admission. File IDs and names enter memory, while raw image bytes stay out of chat snapshots and summaries.

Images retain their originals (up to 8 MB); the browser derives a JPEG of at most 192 KB for Pi. At most four files can enter one reply, including steers. Captured prompt/input bytes are released from the host turn row on completion because Pi retains its durable transcript. Videos and other binary documents are honestly labelled stored-only until extraction in 03b.

Proof (2026-10-11):
- 84 tests passed, including private namespace isolation, upload interruption/replay/collision, Trash/restore, text ranges, HTML download isolation, archive fences, attachment identity and row-size budget regressions.
- Native Pi with SQLite and a deterministic provider verified four maximum-size image blocks across initial input, tool-boundary steering, shutdown/reopen and duplicate replay. No live model or production credential used.
- Local workerd HTTP verification passed for authenticated multipart upload, CSRF, deduplication, immutable ID conflicts, private downloads, safe headers, text ranges, rename, Trash/restore, missing bot and logout.
- Mobile browser verified image/text uploads, actual-button rename, safe text preview and Trash/restore; files persisted through Worker rebuild. Read-only reviews corrected archive admission, row finalization, retry attachment intent, batch busy state and delayed-list races.
- New Alchemy resource: private `WorkspaceAssets` R2 bucket, bound only to AgentWorker. Existing approved R2 permissions suffice; no new credential or public bucket.
- Delivered in PR #6, main `2d4f722`; production run `38096362130` succeeded. Live owner/model acceptance remains deferred. PDF extraction and reusable skills are subsequent slices; video processing follows the execution runtime.


### 03b — Durable PDF text extraction

PDF uploads enqueue a durable background extraction job. A private binding-only `DocumentWorker` parses bytes without storage or credential bindings and has a configured 5,000 ms CPU limit. The agent retains originals and extracted text in its private R2 namespace. Extraction reports page coverage, truncation, readable/empty/failed states and supports explicit retry. Only ready text enters attachment context; scanned PDFs honestly require future OCR.

Proof (2026-10-11):
- 93 tests passed, including ordered text, 50-page/200,000-character bounds, malformed/empty PDFs, real parser cleanup after failed loading, interrupted job recovery, three-attempt bounds, legacy upload upgrade/replay, archive fences, and slow polling/unmount.
- Local workerd checked background extraction across the service binding, private page-labelled text, unchanged original bytes and safe download headers. Browser verified the readable PDF preview in Files.
- Independent reviews found and resolved parser isolation/cleanup, pre-upgrade PDF MIME compatibility, response-starving polling and polling while in Trash. Focused follow-up reviews passed.
- CPU enforcement is configured at Cloudflare's Worker boundary; a production CPU-exhaustion fault was not injected. Output and page limits are independently tested. Early PDF.js stream cancellation races its inline worker, so extraction drains the current page inside the isolated Worker before cleanup.
- New Alchemy resource: `DocumentWorker`, callable only through AgentWorker's service binding. Existing Workers permissions suffice. No owner model credential used in local proof.
- Typecheck, lint, production build and secret scan passed. Delivered in PR #7, main `0a21a76`; production run `38097238664` succeeded.


### 04a — Versioned reusable skill library

The owner has one private library with immutable Markdown revisions and recoverable archive/restore. Each bot pins up to four explicit revisions. Editing the library offers a version update, preserving existing pins. New replies snapshot selected bodies at admission; steers retain the reply's selection. Chat events expose names and versions without copying instruction bodies. Skills convey instructions only and do not grant tools.

The shadcn/Base UI sheet supports creating/editing, local Markdown import, revision history, restoring an earlier version as a new revision, per-bot selection/update/removal, and archival. Conflicting edits preserve the draft and offer comparison with the latest saved version before the user chooses how to proceed.

Proof (2026-10-11):
- 100 tests passed, including immutable revisions, uncertain-save replay, stale-edit conflicts, state-version fencing for archive/restore, isolated bot pins, archived-skill retention, archive-after-RPC fences, legacy conversation migration, frozen admission/steering context, and maximum Unicode skills alongside image inputs under SQLite's row limit.
- Local workerd verified authenticated owner library and child-object RPC selection, explicit updates, archival/restoration, stale writes, CSRF and anonymous rejection. No model credential used.
- Browser verified create → pin v1 → edit v2 → explicit update, persistence after Worker rebuild, mobile history, and two-tab conflict → reload → compare → preserve draft → save new revision. Mobile 390×844 had no horizontal overflow; temporary viewport reset.
- Independent reviews found and fixed stale archive replay, initial-load mutation races, conflict recovery, draft replacement and late import/history results. Both follow-up reviews passed. Typecheck, lint and production build passed.
- No new Cloudflare resource or permission. Selected bodies remain private SQLite data, not repository files. Executor-hosted import is 04b, built with the scoped connection/approval path in slice 05; local Markdown import does not claim a live Executor connection.
- Secret scan passed. Delivered in PR #8, main `308068e`; production run `38098209727` succeeded.


### 05a — Per-bot tool policies and durable approvals

All seven built-in Pi tools pass through the Access context before execution. Each bot has revisioned Allow/Ask/Deny settings. Ask records the exact tool inputs and pauses for a durable, single-action decision with a 15-minute expiry. Revocation cancels waiting approvals, stop cancels the reply's pending actions, and completed replies clear remaining requests. Changing policy before dispatch can require a new approval round; stale decisions cannot approve that newer round. Existing private memory/file tools retain their prior Allow default. External connections will start with Ask.

The shadcn/Base UI Tools sheet edits policies; chat displays the action, exact inputs, expiry and Allow once/Deny controls. Successful changes survive older event snapshots. Phone layouts keep the bot identity and status on one row with feature actions below.

Proof (2026-10-11):
- 112 tests passed. Real Pi harness with SQLite and a deterministic model covers restart while waiting, approval exactly once, stop, revocation, interrupted dispatch with explicitly unknown outcome, and a large tool result retained with a truncation diagnostic. No real model credential is used.
- Operation intent is committed before dispatch, and the bounded returned result is stored before completion. A restart after dispatch but before receipt cannot silently repeat the effect. This deliberately reports an unknown outcome; it does not claim exactly-once delivery by external services.
- Policy and approval revisions fence stale changes; tests cover expiry, cancellation, fresh approval rounds and frontend reconciliation. Local workerd checks verified isolated policies, uncertain-update replay, stale/oversized/invalid requests, metadata, missing/archived bots, CSRF and logout.
- Independent reviews caught and corrected large raw-result failure and a stuck approval card after a new policy round. Focused re-reviews passed.
- Receipt capture currently covers explicit tool results, which all seven built-in tools return. Future streaming execution tools must include their output/diagnostic side channels in durable receipts. Executor/MCP connections and hosted skill import follow in 05b/04b.
- Browser verified changing write_note to Ask and persistence across reload. A synthetic pending approval rendered its exact inputs and actions; native Pi tests, rather than that fixture, prove execution. At 390×844 the corrected header retained the bot name and had no horizontal overflow; the viewport was reset.
- Typecheck, lint and production build passed. No new infrastructure or cloud permission. Secret scan and deployment pending.
