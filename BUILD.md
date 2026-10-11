# Durable Pi — build tracker

Started 2026-10-10. Delivery owner: Codex. Status: **slices 01–08, including Linux/PTY/file transfer and generated apps, deployed; 09a scheduled routines verified locally**.

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
| 04 — Reusable skills | Create/edit/attach skills to bots; durable revisions; selected skills enter context; import through the intended Executor source; scoped access and recovery. | 04a and 04b deployed |
| 05 — Tools and approvals | Connect Executor/MCP; assign tools per bot; Allow/Ask/Deny enforced server-side; approval persists across reload/restart; background work cannot bypass approval; revoke access. | 05a and 05b deployed |
| 06 — Browser | Bot browses on Cloudflare; observe and take over in the workbench; authenticated Chromium sessions; Kitesurf for compatible short tasks; session expiry/reconnect and destination controls. | 06a and 06b deployed |
| 07 — Execution and terminal | Isolated fast code execution plus on-demand Linux container; live terminal; files persist across container restarts; bounded time/output/network; cancel and recover. | 07a–07d deployed |
| 08 — Generated apps and inline UI | Bot creates, previews, updates and runs an app; versioned private publication; isolated execution/storage; inline UI uses a bounded renderer; interactions return events to the owning bot. | 08a and 08b deployed |
| 09 — Routines and incoming events | Schedule/pause/delete routines; run with browser closed; authenticated webhook triggers; durable retry/deduplication; notify on meaningful outcomes; respect bot grants and budgets. | 09a once/interval routines verified locally; incoming events next |
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
- Typecheck, lint, production build and secret scan passed. No new infrastructure or cloud permission. Delivered in PR #9, main `aa0358e`; production run `38099292561` succeeded.


### 05b — External MCP connections

The owner connects public HTTPS Streamable HTTP servers in **Connect**, completes provider OAuth if needed, and chooses up to 16 tools per bot. The account object owns native MCP transport/OAuth state; child bots keep pinned tool definitions. New and re-added tools default to Ask, and the existing durable approval gate owns their execution receipts. Connection generation and definition hashes invalidate stale selections after reconnect or schema changes. Removing a tool revokes waiting operations and resets any automatic grant.

Native `MCPClientManager` persists discovery/credentials and handles issuer-bound OAuth, state and PKCE. The app accepts no endpoint credentials, query strings, custom ports, or private literal addresses; native SDK protections remain enabled. Tool errors omit provider internals. Model-visible text/images and structured-only JSON results pass through bounded receipts. Unsupported resource formats get an explicit placeholder. OAuth elicitation and scope expansion are not silently accepted. Already-dispatched remote work can finish after Stop/disconnect; interrupted outcomes must be checked at the remote service before retrying.

Proof (2026-10-11):
- 136 tests passed, including real Pi/SQLite restart with a remote JSON Schema, per-bot selection, stale updates, archival during resolution, revocation, grant reset and bounded result projection.
- Local workerd connected to Cloudflare's public documentation MCP server, discovered real tools, selected a tool for one bot, verified default Ask and isolation, disconnected/reconnected with changed tool identity, rejected stale selection, archived-bot writes, forged callbacks, unauthenticated requests and foreign origins. The script is `scripts/check-connections.ts` and uses only the synthetic local account.
- A separate native MCP manager/adapter probe executed the public documentation search and received usable model content. It used an in-memory SQLite fixture; this is not a hosted owner-model or owner-Executor connection claim.
- Actual SDK OAuth tests simulate rotating tokens, differing concurrent flows, failed-flow cleanup, provider isolation, one-use state/PKCE, and disconnect during an in-flight token exchange. No real OAuth credentials are used.
- Security review reproduced an upstream concurrent-refresh bug that can delete the winning refreshed credential. A narrow, pinned pnpm patch serializes SDK `auth()` per provider and shares identical in-flight requests; original issuer/PKCE validation remains intact. Re-evaluate/remove the patch when upgrading the SDK. A generation-bound native provider storage adapter also prevents stale SDK work from recreating or deleting credentials after disconnect/reconnect.
- Native workerd rejects `redirect: error`; transport requests now use manual redirects. Website-to-agent forwarding preserves callback redirects for the browser. Independent focused reviews passed after fixes.
- Browser verified a real discovered tool's selection, persistence after reload, and Ask state. At 390×844 the header and Connections sheet fit with no horizontal overflow; viewport reset. One transient unavailable selection during development reload recovered by reloading connections.
- Typecheck, lint and production build passed. No new infrastructure or Cloudflare permission. Owner OAuth connections remain optional user setup, not a blocker for later slices. Secret scan passed for all 208 tracked files; delivered in PR #10, main `d85956f`; production run `38101419107` succeeded. Fresh-page browser logs contained no errors.


### 04b — Hosted skill import

Status: deployed in PR #11, main `4ff1fb4`; production run `38102126049` succeeded. The owner chooses a ready Executor connection and app, browses the catalog, previews a pinned SKILL.md, and explicitly saves a local library revision. Source metadata records app, deployment, revision, profile when present, connection and reference file names. Library edits and bot pins keep their existing isolation/recovery behavior. Provider updates never silently change a bot's selected copy.

Acceptance: reject mismatched provider identities, stale/disconnected tools, malformed or truncated/oversized responses; preserve existing SQLite skills and revision history; keep source metadata through save, edits, restore and bot selection; canceling or changing views cannot replace a newer draft; authenticated workerd and browser checks. Only the owner import route invokes the `skills` read protocol. It never calls `execute`, accepts arbitrary remote tool names, changes bot grants, or copies this Codex session's credentials. Referenced files are not bundled: the UI and admitted context explain that access requires the bot's selected provider tool and normal approval policy.


Verification for 04b:

- 153 tests, including import protocol, source identity mismatch, disconnect during read, refusal of arbitrary tools, truncation/error redaction, aggregate 16 KB source metadata, old-table migration, immutable source revisions, per-bot pins and four large Unicode skills with image input under the SQLite row budget.
- `scripts/check-skill-import.ts` uses a synthetic provider preview, then saves/edits/selects it through real local workerd. It checks bot isolation, pinned text/source retention, CAS conflicts, unregistered-provider rejection, 401 and foreign-origin 403. No owner Executor credentials or skill contents are used.
- Browser verified source details, reference access guidance, v1 bot pin alongside v2 library copy, import choices, no-connection state and cancellation. At 390×844 the sheet and document measured 390 px wide with no overflow; viewport reset. Independent backend and frontend reviews found no actionable defects.
- The Executor response contract was compared with live read-only catalog and pinned-skill responses. This is not an authenticated owner connection E2E claim: connecting the app's Executor account remains optional owner setup. No new Cloudflare resource or permission is required.


### 06a — Guarded browser navigation and inspection

Status: deployed in PR #12, main `6898bfe`; production run `38103740411` succeeded. One private Chromium session per bot, persisted identity, an owner-edited exact hostname allowlist enforced by Cloudflare session guardrails, and two Ask-by-default Pi tools for navigation and inspection. Page text/links and bounded screenshots appear in a responsive workbench beside chat. No arbitrary script execution or credential inputs are accepted. Session cleanup has a durable retirement queue and a ten-minute deadline, with two-minute Browser Run idle expiry. Revoking settings/closing a session fences results already in flight. 06b adds interaction, human takeover and authenticated-session handoff; Kitesurf is deferred until a stateless path can preserve destination restrictions because its current service does not support session guardrails.

Reference: [Browser Run binding](https://developers.cloudflare.com/browser-run/reference/browser-binding-api/), [Puppeteer](https://developers.cloudflare.com/browser-run/puppeteer/), [guardrails](https://developers.cloudflare.com/browser-run/features/guardrails/), [session reuse](https://developers.cloudflare.com/browser-run/features/reuse-sessions/), [Live View](https://developers.cloudflare.com/browser-run/features/live-view/), [human handoff](https://developers.cloudflare.com/browser-run/features/human-in-the-loop/). Installed Alchemy Browser binding adds no backing resource; existing Workers deployment permissions apply. `@cloudflare/puppeteer` is pinned to 1.4.0.

Verification for 06a:

- 184 tests cover generation revocation during acquire/navigation, queued Stop, actual Effect interruption retaining the tab semaphore, isolated-page extraction and host bounds, capture-version matching, idle renewal/absolute expiry, archive cleanup and retry. Typecheck, lint and production build pass.
- `scripts/check-browser.ts` passed through local workerd and the real remote Browser binding: owner authentication/CSRF, per-bot isolation, native guardrail confirmation, example.com navigation, bounded text/JPEG, reconnect/refresh, forbidden destination and cross-host redirect, stale image rejection, close and stale-generation rejection. The local Chromium emulator accepted guardrail options without enforcing them; the binding is therefore remote and session acquisition fails closed unless the native blocked-request probe succeeds.
- Browser checked initial launch → Close → fresh launch, real screenshot/text, wide pane, narrow sheet and 390×844 fit. At 900 px, review exposed a collapsed bot title; container-based header wrapping now preserves it. Slow polling is serialized; first launch is always closable; stale image versions cannot show another page under old metadata. Temporary viewport overrides were removed.
- Independent backend/frontend reviews corrected cancellation ownership, page-realm tampering, archived cleanup, idle renewal, slow reads and capture races. No owner/model credential is used in local verification. Navigation and inspection are implemented; interactions, sign-in takeover and return-to-agent control are tracked in 06b.
- Browser adds an Alchemy binding only; existing Workers permissions suffice. Dev uses an authenticated Cloudflare profile and consumes normal Browser Run usage. DocumentWorker now has explicit local port 1339 to avoid first-start collisions with the website on 1337.

### 06b — Browser interaction and owner control

Deployed in PR #13, main `2d39c2a`; production run `38105176070` succeeded. Screenshot-based click, text, key and scroll actions, Ask-by-default model interaction, and an explicit owner-control mode for sign-in or sensitive fields. A durable generation change pauses bot browser actions during takeover; stale commands and observations fail. Returning control keeps the same private Chromium session and its cookies. Owner command inputs are ephemeral and excluded from chat/tool receipts. Captures mask editable field values and omit editable text. A site can independently reflect submitted text outside those fields; returning control makes the resulting page available to the bot.

Use authenticated application commands with capture-version checks for this first control surface. Cloudflare Live View URLs are bearer credentials whose expiry does not terminate an established viewer; issuing them directly would need an additional revocation boundary. The app-owned control surface keeps revocation under the same bot authority. Live streaming can be added later without weakening that boundary. No browser warning bypass, arbitrary JavaScript execution, downloads or cross-bot cookie copying.


Verification for 06b:

- 201 tests passed, with typecheck, lint and production build. Coverage includes owner takeover fencing, session reuse, private command input, consumed action versions, interrupted execution/recovery, late operations, unknown focus, normalized password/OTP attributes, screenshot masking and restoration, and refresh-before-retry after an uncertain result.
- `scripts/check-browser-control.ts` passed through local workerd and real Cloudflare Chromium: Selenium’s public synthetic form, native Tab/type/click/scroll, sensitive-field metadata, stale action rejection, owner control/return, and synthetic cookie continuity. No owner credentials or live model were used.
- Read-only reviews identified uncertain action retries and sensitive focus/capture edges; fixes require a ready current observation, fail closed on unknown typing targets, and mask editable values in captures. Typed values in standard input/textarea fields and open shadow controls are masked; unsupported iframe/closed-shadow typing fails closed. Editable link text is excluded. Arbitrary script execution remains unavailable.
- Browser verified takeover → remote Tab → private Type (local field clears) → masked capture → return, followed by takeover and Close on 390×844. No horizontal overflow; temporary viewport overrides removed. Backend/frontend follow-up reviews closed with no remaining actionable findings.
- No new infrastructure/permissions. Secret scan passed for 227 tracked files. Whole-repository formatting check still reports four pre-existing files outside this slice; changed TypeScript files pass formatting. Production build retains the existing chunk-size advisory.


### 07a — Isolated JavaScript execution

Deployed in PR #14, main `989e6d4`; production run `38106140200` succeeded. A bot/owner can run bounded JavaScript against explicit JSON input, see code/result/log history, cancel, and recover interrupted runs without implicit re-execution. Ask-by-default Pi tool and authenticated Code workbench share one bot-local execution context. Persist admission before dispatch and retain 500 immutable run records (latest 50 in the list). New work cannot access sibling bots or inherit storage, credentials or network. Private ExecutionWorker with Worker Loader owns isolation and platform CPU limits. Runtime receives only the provided input. Full Linux/PTY, persistent files and media preprocessing follow in 07b/03c.

Limits: one active run per bot, 16,384 code characters, 32,768 JSON input/result characters, 16,000 log characters, 1 second CPU and 10 seconds elapsed. Host independently bounds untrusted output. No automatic retry after a restart or uncertain response. An explicit new run receives a new ID.

References: [Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/), [resource limits](https://developers.cloudflare.com/dynamic-workers/usage/limits/), [Cloudflare code interpreter](https://developers.cloudflare.com/sandbox/get-started/build-an-ai-code-interpreter/). Current Sandbox docs have moved beyond the bundled preview skill's API; use the live docs and installed types. No new permission is expected for the private Worker/Loader binding.


Verification for 07a:

- 213 tests passed, with typecheck, lint and production build. Tests cover durable admission, identical retries, conflicting payloads, bot isolation, immediate Stop before dispatch, archive fencing, restart without re-execution, independent output limits and body cancellation.
- `scripts/check-execution.ts` passed through authenticated local workerd and its native Worker Loader: result/logs, empty bindings, denied network, malformed code, output/elapsed limits, cancellation, replay, sibling isolation, archived-bot rejection, anonymous 401 and foreign-origin 403. Hostile generated responses cannot follow redirects into another execution or escape the independent stream bound. No owner credential or model was used; platform CPU exhaustion was not probed in production.
- Independent backend review reproduced implicit reruns through generated 307 redirects and an immediate-Stop race. Manual redirect rejection and synchronous abort binding fix both; follow-up native/unit checks pass. Frontend review corrected desktop containment and mobile sheet width; both reviews closed.
- Browser verified run → result 6 → console output → stored code/input. Phone 390×844 verified a running command and Cancel with a full-width sheet and no horizontal overflow; temporary viewport override removed.
- A private ExecutionWorker and Worker Loader binding use existing Workers deployment permissions. Existing infrastructure identities stay unchanged. Changed-file formatting passes; pre-existing formatting warnings and build chunk-size advisory remain outside this slice.


### 07b–07d — Linux, interactive terminal and private file transfer

Locally implemented and reviewed in [PR #15](https://github.com/cill-i-am/durable-pi/pull/15), [PR #16](https://github.com/cill-i-am/durable-pi/pull/16), and [PR #17](https://github.com/cill-i-am/durable-pi/pull/17). The stack includes bounded Linux commands, workspace checkpoints, a live PTY with save/discard, owner-only import/export, and reconnect/cancellation recovery. Native Docker/workerd/R2 checks and desktop/mobile journeys passed; detailed evidence lives on those branches. The owner approved Workers Containers Read/Write and deployment on 2026-10-11. The existing account-scoped CI token was updated through Alchemy (only DeployToken changed). No production terminal capability is claimed yet.

### 08a — Private generated apps and inline UI

Deployed in PR #18, main `38a47bf`; production run `38112475178` succeeded. Bot-local immutable app definitions support plain text, metrics, tables, checklists and forms. Saving creates a draft; publication chooses a saved version privately. A bounded React renderer uses shadcn/Base UI and executes no generated scripts, HTML, resource URLs or network requests. Owner interactions commit app state and an event outbox together; a durable lifecycle runner admits each event once to the owning bot's normal conversation queue. Existing tool policies apply, and `publish_app` defaults to Ask. Offline model connections retain events.

Limits: 50 apps per bot, 50 saved versions per app, 20 blocks/24,000 definition characters, 64,000 saved-state characters, 20 pending bot updates, 2,000 mutation/cancellation receipts per bot. Model reads use bounded JSON-text pages with snapshot hashes. The workbench and inline publication result both read the same private version/state. Draft edits stay private until publication. No new infrastructure or permission.

Acceptance: owner authentication and per-bot isolation; draft/publish/rollback/archive; state retained only for declared stable component keys; exact request replay and cancellation tombstones; transactional event admission/restart; oversized/invalid data fails without poisoning state; dirty forms keep their baseline through polling and desktop/mobile layout changes. Arbitrary generated web code and its isolated runtime remain 08b.

Verification for 08a:

- 229 tests pass, including native Pi draft creation, Ask-before-publication, harness restart, approval replay and the actual committed result rendering as an inline app reference. Synthetic model only; no owner credential or live inference.
- `scripts/check-apps.ts` passes through authenticated local workerd: draft/publish/version history, checklist/form persistence, replay/conflict, cancellation tombstones, isolated bot catalogs, archived-bot rejection, anonymous 401 and foreign-origin 403. Offline events remain durable and pending. Unit tests prove transactional conversation admission/rollback and restart without duplicate turns.
- Backend review corrected escaped oversized event admission, repeated form labels, and large tool-result truncation. Model reads now page bounded text with a snapshot checksum. Frontend review corrected late creation completion, stale form overwrites, background version switching and premature mutation unlock. Focused re-reviews closed.
- Browser verified create → preview → publish → interact, persistence after reload, form save at 390×844, dirty draft preservation across desktop/mobile transitions, concurrent form-update conflict, and background publication without replacing the open version or unsent text. Mobile panel and document both measure 390 px; desktop toolbar wraps without clipping. Temporary viewport overrides removed.
- Typecheck, lint and production build passed. Existing chunk-size advisory remains. No new Cloudflare resources or permissions; Linux PRs remain separate and pending provisioning approval.


### 08b — Custom apps running on Cloudflare

Deployed in PR #19, main `60fdff6`; production run `38113900807` succeeded.

Added a versioned web block whose JavaScript executes in the existing private Dynamic Worker. Its inputs are its own bounded JSON state and a validated owner action; its outputs are bounded semantic HTML, CSS, next state and an event summary. Rendering is pure. An action commits state and its bot event together only after the original revision, cancellation and bot authority remain valid. Duplicate requests replay the committed receipt without rerunning code.

The browser receives parsed allowlisted HTML in an opaque frame with restrictive CSP and one trusted nonce-protected control bridge. Generated JavaScript stays on Cloudflare. There are no external resources, arbitrary client frameworks, public sharing or parent capabilities. Native forms and buttons dispatch authenticated actions; a changed saved revision requires explicit reload.

Proof (2026-10-11):
- 246 tests passed, including malformed/complex markup, state bounds, replay, pure previews, cancellation, archive/restore across both execution and Promise continuation boundaries, and unchanged state after failed execution.
- Native workerd E2E passed through the real ExecutionWorker binding: render, saved form action, replay, conflict, cancelled admission, denied outbound fetch, timeout and invalid output. No model credential used.
- Browser verified native form submission (including the formerly clobbering `dataset` field name), counter actions, invalid-action recovery, reopening, persistence, unsent fields across desktop/mobile resize, and no horizontal overflow at 390 px. A hostile-markup fixture retained only allowed text/form controls and did not navigate.
- Read-only backend/frontend reviews found and corrected blocked native submissions, form property clobbering, reserved-name recovery, late archive/restore commit and stale archive configuration. Follow-up reviews passed. Development effect replay also exposed duplicate rendering; concurrent render loads now share their in-flight request.
- Typecheck, lint and production build passed. Existing private ExecutionWorker is reused; no new cloud permissions or resources.


### 07b — Linux execution, terminal and workspace recovery

Deployed in PR #15, main `1a1785e`; production run `38114750782` succeeded. Permissions were approved and applied on 2026-10-11. One on-demand private Linux container per bot, owner command workbench and Ask-by-default model commands, durable intent/output with no implicit replay, hard Stop, recovery cleanup, and private R2 workspace checkpoints. App/model credentials remain outside the container. Outbound networking is disabled. Four concurrent instances cap this container application. Interactive PTY and explicit private file transfer follow in 07c and 07d.

Decision: native `Container.exec` was present but stalled under both Alchemy beta.81's bundled runtime and a temporary current-workerd probe. That override was removed. A matching Sandbox SDK/container 0.12.10 RPC probe passed. Use its documented 0.x compatibility API behind the bounded adapter, with an immutable amd64 image digest. Alchemy's default scheduling policy supports the fixed image and `maxInstances`; the new `durable_object` policy has a different control-plane schema. No custom command bridge was invented.

A command has 30 seconds for cold start, restore, execution and checkpoint. Only `/workspace` survives; `node_modules`, `.git` and `.cache` are excluded. Checkpoints have a host-enforced 8 MiB compressed cap and SHA-256 validation, scoped to the bot's object. Up to 500 immutable commands, latest 20 metadata summaries, 64,000 output characters. Nonzero exits can save files; failed/interrupted/cancelled checkpoint attempts preserve the prior head. All descendants are killed by container teardown; SDK timeout alone does not kill them. Interrupted commands are not replayed.

Verification (2026-10-11):
- 228 total tests passed; typecheck, lint and production build passed. Dedicated tests cover late startup, cancellation before admission, late checkpoint publication, restart with a surviving runtime, cleanup failure/retry, stale archive revisions, bounded hostile streams, and sequential model tools waiting for cleanup.
- Real local workerd + Docker + R2 E2E passed: output, write/checkpoint/destroy/fresh restore, identical replay/conflict, sibling isolation, outbound-network denial, output bound, Stop/rollback, stop-before-dispatch, archive/restore, anonymous401 and foreign-origin403. The synthetic account has no real model credential. Native cloud container execution is not yet claimed.
- Review identified surviving processes after a DO restart and completion reported before teardown. Recovery now holds a cleanup barrier; new commands fail closed when cleanup cannot be confirmed. Model results wait for idle. Both review findings are closed.
- SDK startup can deliver a previous stop event while opening its next RPC channel. The adapter explicitly awaits native port readiness before restoring files, avoiding implicit retries of user commands. The fresh-restore E2E proves this path.
- Desktop1280 test caught the growing toolbar approaching overflow. Browser/Code/Terminal now share a shadcn/Base UI workbench menu; actions occupy485px within544px. Terminal UI run saved a file and showed output/checkpoint; phone320×844 verified reopening the workbench and reading the saved file in a fresh container. Dialog and document were320px with no horizontal overflow; toolbar was271px. Temporary viewport overrides removed.
- Deployment adds a private TerminalWorker, LinuxSandbox Durable Object/container application, and the existing WorkspaceAssets R2 binding. The manual CI setup diff adds only Workers Containers Read/Write on this Cloudflare account. Only the existing DeployToken permission policy was updated; no GitHub secret was rewritten.

References: [SDK commands](https://developers.cloudflare.com/sandbox/sdk/api/commands/), [native Container API](https://developers.cloudflare.com/containers/api/durable-object-container/), [terminal guide](https://developers.cloudflare.com/sandbox/sdk/api/terminal/), [R2 directory backups](https://developers.cloudflare.com/sandbox/files/back-up-a-directory-to-r2/), [scheduling policies](https://developers.cloudflare.com/containers/configuration/scheduling-policy/), [local runtime requirements](https://developers.cloudflare.com/containers/guides/local-dev/).

Deployment integration review found that restore could overtake archive delivery to the private terminal service. Commands now record their admission authority revision; a separate durable revocation watermark cancels older work even after a newer restore, while preserving work admitted after that restore. The host forwards the archival edge independently of its current status. Regression tests cover both reordered delivery and the final checkpoint fence.

### 07c — Interactive terminal

Implemented and verified locally on the merged 07b slice. An owner can open a native Linux PTY, type commands, resize, interrupt with Ctrl+C, reconnect, and explicitly save or discard the workspace. This slice adds no permissions beyond 07b; it must follow that infrastructure deployment.

- One owner viewer and one execution owner per bot; concurrent command admission is refused. Reconnect retains the native 256 KiB replay buffer. App/model credentials and SDK control endpoints remain outside the socket boundary.
- Every socket upgrade checks owner authentication and the app origin. An authenticated HTTP lease renews every ten seconds; socket traffic cannot extend it. Closing the workbench, logout or prolonged disconnection ends the lease within thirty seconds. Sessions have a fixed ten-minute maximum, 256,000 input bytes and 4 MiB output/replay bytes. Terminal content is not persisted in chat/history.
- Save closes the shell, checkpoints `/workspace`, and destroys the container. Discard, expired authority and interruption retain the prior checkpoint. Pending connection work participates in the Save/Stop cleanup barrier, preventing late SDK startup from reviving a container after admission is released.
- The workbench owns renewal across tab and desktop/mobile changes. Brief network failures retry within the confirmed lease. Saved, discarded and failed-save results remain visible in history; a failed save does not imply persistence.
- The image explicitly installs Python 3 minimal; the pinned upstream base only includes Node/Bun. Native output-limit and 270,000-byte replay checks use Node and assert real generated bytes, so missing executables cannot masquerade as a passing limit check.
- Native testing found Bash lacked a controlling terminal under the pinned SDK's Bun PTY. A fixed image-local `setsid --ctty bash -i` launcher restores job control; native resize and Ctrl+C checks pass. No downloaded runtime script or arbitrary shell selector is exposed.
- 239 tests, typecheck, lint and production build pass. Independent reviews corrected pending-connect cleanup, full-buffer replay, failed-save visibility, transient-renew recovery and tab/layout lifetime. Follow-up reviews passed.
- `scripts/check-interactive-terminal.ts` passed against local workerd, Docker and R2: owner/origin/sibling rejection, exclusive viewer, resize, Ctrl+C, full-buffer reconnect, save/fresh restore, replay, Stop/rollback, and logout while socket traffic continues. The Vite dev upgrade bridge drops non-101 replies; rejection checks use the same Upgrade header through its HTTP path to inspect the Worker's status, while successful sessions use real WebSockets.
- Browser QA on desktop and mobile verified actual typed input, saved-file restore, tab/layout reconnect, explicit discard and a real oversized-checkpoint failure displayed after reload. Owner/model acceptance remains deferred; local container proof and hosted deployment remain separate checks.

Integration against the deployed-apps main branch passes 275 tests, typecheck, lint, build and secret scan. Interactive admissions retain the new authority revision; a regression test verifies delayed archive revocation ends an older PTY but permits a restored PTY to save. Independent backend review also verified revocation during an in-flight Save.

### 07d — Private file transfer

Implemented and verified locally on the pending terminal branches. **File transfer → Copy from Files** copies an explicitly selected asset into a fresh `/workspace/imports/<operation-id>/` directory and checkpoints it. **Prepare export** reads one regular file from the saved workspace into immutable private R2 storage. The owner can download it or add it to this bot's Files library, which applies its existing validation and image-preview preparation.

- File authority is resolved by the owning bot. Only explicit bytes cross into the container; no R2 credentials, model credential or application binding does. Files are non-empty and at most 8 MiB. Runtime directory-descriptor walks reject traversal, symlink parents/files, directories, FIFOs and other special files. Imports never overwrite existing files.
- Transfer IDs reuse the command admission, cancellation, teardown and restart guarantees. Import retries recover the first receipt after source rename/trash; conflicting source IDs fail. Cancellation persists before clearing an unconfirmed UI request, so delayed admission cannot execute. Exports do not replace the workspace checkpoint and are published only after successful completion.
- Raw downloads preserve arbitrary bytes with attachment, sandbox, no-store and nosniff headers. Files-library validation remains separate; a valid export can be downloaded even if library encoding/type/quota rules reject it.
- 247 tests, typecheck, lint and production build passed. Regressions cover immutable/replayed imports and exports, cancellation before/after admission, retry after mutable source changes, concurrent receipt recovery, and binary CSV downloads. Independent backend/frontend reviews closed all findings.
- Native local workerd/Docker/R2 harness passed import → checkpoint → fresh restore → export, byte equality, replay after rename/trash, cancellation before admission, sibling/anonymous rejection, symlink/FIFO/directory/path and 8 MiB bounds. Strengthened command-output and full-PTY-buffer probes also pass with actual generated-byte assertions.
- Browser verified validation remains editable, export → Files → import, protected direct download, persisted results and desktop1280/mobile390 layouts without horizontal overflow. Temporary viewport overrides removed. The synthetic account has no real model credential.
- No additional infrastructure permission beyond pending 07b. This owner-operated transfer slice does not add automatic model file movement or video preprocessing; those follow as explicit capabilities.

File-transfer integration against current main passes 284 tests, typecheck, lint, build and secret scan. The authority watermark fences export receipts as well as workspace checkpoints; a regression verifies revocation during an R2 export write cannot publish the result. Independent review passed. The download link uses Base UI anchor semantics.

### 07b–07d deployment completed

The owner approved Containers Read/Write and deployment. The existing CI token policy was updated without rewriting GitHub secrets. PR #15 deployed main `1a1785e` in run `38114750782`; PR #16 deployed main `149f627` in run `38114921975`; PR #17 deployed main `dd681fe` in run `38115206145`. Each production workflow and hosted authentication check passed. Native command/PTY/file-transfer behavior was proven locally with workerd, Docker and private R2; no authenticated owner/model production session was used for acceptance.

### 09a — Durable scheduled routines

Implemented and verified locally. A bot can run once at a chosen time or repeat every 15–10,080 elapsed minutes while the browser is closed. The workbench creates/edits, pauses/resumes, archives/restores, runs now and stops work; recent runs show waiting, progress and terminal results. Ask-by-default `save_routine` and `set_routine_status` tools use the same durable store. Read tools are allowed by default.

- The bot's SQLite context owns routine intent, run history and stable mutation/cancellation receipts. Domain reconciliation runs through the existing Agents Lifecycle alarm owner. No separate physical alarm, new cloud resource or permission.
- One pending/queued routine per bot; missed intervals coalesce rather than replaying a backlog. Admission and the normal conversation queue share one SQLite transaction. Model unavailability retains pending intent. Ordinary exhausted job errors return a durable retry time (at least one minute) instead of allowing the SDK to remove a live schedule.
- Each admitted run has a fixed ten-minute budget, enforced at conversation and tool boundaries and by periodic stop reconciliation. Existing bot grants/Ask approvals remain in force. No automatic email or push is sent; useful results enter the owning conversation. Pause/archive cancel unadmitted work; already admitted work can finish within its budget unless stopped.
- Limits: 50 saved routines, 2,000 mutation/cancellation receipts and 200 historical runs per bot; 12,000-character instructions. New/rescheduled first runs must be in the coming year. Interval schedules use elapsed minutes rather than calendar/DST rules; the editor labels the local timezone explicitly.
- Drafts retain their captured revision and exact schedule across polling and screen-size changes. Concurrent edits require an explicit Keep my edits / Use saved values choice. Unconfirmed operations retain their identity and block navigation until retried/resolved. Confirmed mutation responses update controls before a refresh, and older reads cannot replace them.

Verification (2026-10-11):

- 14 domain/reconciliation tests cover validation, CAS/receipts/cancellation, missed ticks, atomic queue rollback/restart, pause/resume, bot isolation, duplicate titles, run-now, budgets and exhausted-error retry recovery.
- Native Pi with its synthetic provider verifies owner approval survives harness restart, no routine is armed before approval, and replay creates only one saved routine.
- `scripts/check-routines.ts` passed against local workerd: a due run predates the first subsequent HTTP request, proving an independent alarm; pending-model recovery, pause/resume, Stop, replay/cancellation, revision conflicts and auth/origin/sibling boundaries also pass. Test bots are archived afterward.
- Desktop/mobile browser checks passed create, draft preservation at 390px, concurrent server edit reconciliation, Save, Run now and Stop. No horizontal overflow at 390px and no fresh console warnings/errors. Independent backend/frontend reviews passed after recovery, stale-read and mobile-navigation fixes.
- Typecheck, lint and production build pass; repository test count is 299 with the native Pi regression. Existing build chunk-size advisory remains. Owner live-model acceptance remains deferred at the owner's request.

References: [Agents scheduled tasks](https://developers.cloudflare.com/agents/runtime/execution/schedule-tasks/), installed `agents` 0.27.0 Lifecycle job/error contract, [Base UI Select](https://ui.shadcn.com/docs/components/base/select), [Toggle Group](https://ui.shadcn.com/docs/components/base/toggle-group). Incoming authenticated webhook triggers remain 09b; calendar schedules can be a later enhancement.
