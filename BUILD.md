# Durable Pi — build tracker

Started 2026-10-10. Delivery owner: Codex. Status: **functional build and Paper fidelity F1–F6 deployed; account security deployed and inspected in the signed-in hosted app**. Per-slice verification limits are recorded below and in [UI_FIDELITY.md](UI_FIDELITY.md).

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
| Planning | Task objectives, constraints, steps, evidence references, revisions and conversation bindings | Native Pi documents and request-only projection; never grants permissions or schedules actions |
| Working objects | Authoritative structured objects, targeted edits, revisions, history and change delivery | Native Pi session documents per bot; shared operations for owner UI and agent tools |
| Routines | Scheduled work, webhooks, triggers, deduplication and pause | Authorized work admitted to Conversations |
| Activity | User-visible operations and actionable recovery | Projections of committed domain events; no secrets |

Frontend uses `src/features/<capability>` with a small public entrypoint, feature-local queries/forms/components, and shared shadcn primitives in `src/components/ui`. Routes compose features. Feature code does not import other features' internals. Transport contracts belong to the capability that owns them. Backend domain/application code must not import Cloudflare or React.

Keep the existing PersonalAgent namespace, memory tables, AuthDatabase, MemoryBackups bucket, production hostname, and encrypted deployment state. The original owner chat becomes the default bot without copying/deleting history. Multiple bots share a single account-level credential refresh owner; rotating an OAuth refresh token independently in several objects is forbidden. No credentials, conversations, local auth state, or private assets enter GitHub.

Visual thesis: a quiet, warm workroom with compact navigation, readable conversation, and a contextual workbench. Composition: bot sidebar → conversation → optional workbench. Interactions: keyboard-first menus, restrained pane transitions, clear running/approval/recovery states; respect reduced motion. Semantic tokens own colors, type, spacing, and radii for later retheming.

## Bot communication — durable inbox and outbox (2026-10-11)

Status: PR #43 merged as `f9e9575`; its CI and production run 38140818968 passed. Hosted signed-in verification found mixed Worker/DO versions during Cloudflare propagation; the agent Worker was temporarily rolled back without changing storage while an additive RPC compatibility correction is verified. Hosted demonstration remains pending. Internal bot communication is a separate bounded context from temporary child delegation. Preserve PersonalAgent, its namespace and SQLite/Pi history. No external account connection or public RPC server is part of this work.

- [x] Slice C1: Effect schemas and RPC over the existing private Durable Object binding; SQLite inbox/outbox, committed acknowledgments, conflicting-ID rejection, bounded retry and restart recovery with a deterministic handler in real workerd.
- [x] Slice C2: Existing named bots delegate a bounded task/question through Pi, commit a result/outbox atomically, and resume a correlated durable dependency without an open browser. Preserve model routing, cancellation and tool authority.
- [ ] Slice C3: Activity progress, results/input requests, cancellation and safe delivery retry; desktop/mobile verification, independent review, CI, deployment and restart demonstration.

Delivery is at least once. Acceptance means a committed inbox receipt; execution and durable result completion are separate states. SQLite owns mailbox state. Pi owns model/tool checkpoints. No transaction spans bots, network calls or inference. Stable identities and conflict checks prevent duplicate admission; they do not promise exactly-once model requests or external effects. Terminal deduplication records are retained, and every message has a bounded deadline and retry budget.

Use the installed Alchemy Effect RPC bridge on PersonalAgent rather than replacing the host with RpcDurableObject. The transport is Effect RPC HTTP framing over a private DO binding, distinct from native method RPC. Derive the receiving bot from its persisted server identity; verify each envelope against the sending bot's committed outbox and the same owner's active bot catalog. Browser routes cannot forward internal RPC. A mailbox Lifecycle capability shares the existing alarm owner; no direct setAlarm or detached scheduler.

Effect PersistedQueue 4.0.1 was evaluated: its SQL adapter has durable rows/leases but scoped polling and finalizer-driven acknowledgement, silent duplicate-ID offers, and no Lifecycle wakeup adapter. The installed `@effect/sql-sqlite-do` 4.0.1 driver supports Effect SQL transactions, but its asynchronous transaction ownership is separate from the existing synchronous host transaction used for conversation admission. Using it would still require a custom store for atomic task/result/outbox writes, conflict receipts and Lifecycle wakeups. Use a small explicit Effect repository over the existing synchronous DO SQLite boundary instead. Transaction bodies never suspend; orchestration, clock/randomness, typed failures, retries and transport remain Effects.

Skill provenance (read outside the application repository, not vendored): skills main `5f0444701d83f8b30aa6f18b58c72273cd63f49d`; open [Effect PR #14](https://github.com/cill-i-am/skills/pull/14) head `9520ce7b35169d188d0f634825a7331c7f6f5d3a`, `skills/stack/effect-v4/SKILL.md` and RPC, SQL, persistence, runtime and testing references; open [Alchemy PR #13](https://github.com/cill-i-am/skills/pull/13) head `36897eb24dadcd72a61d67a1ac5b9a6c24eedcf9`, `skills/infrastructure/alchemy/SKILL.md` and version, RPC, DO, runtime and testing references. Executor's older bundle revision `cddabf4b664f6a24bd03a1b29bf4e47b6872e4a21bc0d51f029ffb8c8c441717` was inspected first; PR guidance takes precedence. Neither skills PR was changed. Installed versions remain Effect 4.0.1, Alchemy 2.0.0-beta.81, agents 0.27.0 and Pi Durable 1.0.4.

Sources: [Alchemy Effect RPC and manual DO bridge](https://alchemy.run/cloudflare/apis/effect-rpc/), [Effect PersistedQueue](https://effect.website/docs/v4/api/effect/persistence/PersistedQueue), [Cloudflare alarm semantics](https://developers.cloudflare.com/durable-objects/api/alarms/), matching installed source/types. Evidence below will distinguish source review, typecheck, local SQLite tests, real workerd transport/restart tests, and hosted verification.

Local implementation and bounds:

- Tools: `discover_bots`, approval-governed `delegate_bot`, and `check_bot_task`. The first slice is deliberately text-only: the recipient receives its instructions and the explicit brief, with native Pi `extensions: []` and `tools: []`. No working-object access, external-action grant, recursive bot request, account integration or API-key fallback is introduced.
- Up to three open tasks per direction and three total tasks per originating turn; depth one; ten-minute task deadline; three provider attempts including native recovery; 30-second execution/delivery leases; eight automatic delivery attempts with jitter up to 60 seconds; result/cancellation delivery window 24 hours. Explicit failed-delivery retry preserves identity and monotonic attempt numbers. It does not rerun the task.
- Retain deduplication records without pruning; reject new tasks at 10,000 retained tasks. Inbox/outbox allow three records per retained task so an accepted job can still emit its terminal result. Activity selects 100 tasks, prioritizes unfinished dependencies, and includes their matching deliveries. Recovery prioritizes all live jobs before paging completed result backlogs.
- Pi's installed settings are harness-wide. Active communication execution documents pin the recipient's selected model/effort/verified account window and recover those pins before native execution resumes. Concurrent runs conservatively use the smallest active context window and the largest actual output allowance for compaction reserves. ChatGPT sign-in rejects `max_output_tokens`; this integration does not claim a hard output-token cap. The prompt asks for at most 3,000 words, briefs are bounded, and request count/deadline bound recovery. Reported provider usage is attributed to the communication task, not an unrelated foreground turn.
- A result resumes through atomic local conversation admission with an internal `communication` origin and deterministic operation ID. It is not steering into an unrelated active reply, does not masquerade as a user message, and cannot grant tools. Cancellation consumes the dependency without restarting stopped work. A request needing input is a durable terminal outcome and does not poll the model.

Verification evidence (2026-10-11):

- Source-reviewed the installed Alchemy runtime-only `Cloudflare/Bridge`, Effect RPC HTTP/NDJSON, SQLite transaction and Pi document/submission/provider/compaction/Lifecycle seams. Existing DO class, namespace and storage identities are unchanged. No dependency or cloud permission change.
- `pnpm verify`: typecheck, complete Vitest suite, native runtime integration and production build. Focused tests cover concurrent deduplication, conflicts/owner rejection, lost acknowledgments, atomic result rollback, cancellation before acceptance, retry/deadline exhaustion, admission rollback/recovery, original-turn cancellation, model pin restoration and limits, and real Pi submission/usage recovery. Final local result: 468 tests across 69 files pass; full lint, production build and the staged-source secret scan pass.
- `pnpm test:communication-runtime`: actual workerd 1.20260918.1 (Alchemy dependency), two SQLite Durable Objects, private Effect RPC and shared Lifecycle alarms. Kill/restart the process over the same disk before delivery, after acceptance/lost acknowledgment, during result delivery and during a native Pi model attempt. One admitted task, one durable result and one synthetic continuation event survive; model attempts may repeat within budget. The fixture's continuation event proves mailbox recovery, not a hosted PersonalAgent response. The hosted journey remains a separate check.
- Independent read-only authority and recovery review found and corrected transactional fan-out, ambiguous permission failure, model-budget/usage attribution, retained-result capacity and recovery pagination issues.
- Local browser: real authenticated empty state, plus explicitly mocked populated/failure/input states at 1440×1000 and 390×844. Retry and cancellation dispatch one control each; details remain expanded after refresh. The new Bot communication section passes axe-core with zero violations on desktop/mobile. Mocked UI states are rendering evidence, not production delivery proof.

## Account security — two-factor and browser sessions (2026-10-11)

Status: deployed in [PR #41](https://github.com/cill-i-am/durable-pi/pull/41), main `73fa681`, through successful [production run 38137563664](https://github.com/cill-i-am/durable-pi/actions/runs/38137563664). Identity owns factors and session revocation; agent grants, model connections and background work remain separate.

- [x] Ground in existing Quiet Workroom patterns and design desktop overview, authenticator setup, recovery codes, sign-in/recovery/error states and mobile security in [Paper, boards 36–39](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-1-0).
- [x] Better Auth native TOTP, encrypted recovery codes, verified enrollment, challenge sign-in and password-confirmed management. No remembered-device bypass; factor changes revoke other sessions.
- [x] Owner session list with inferred browser/device labels, current browser, creation/expiry times, individual and other-browser revocation. Session tokens stay in transient client state.
- [x] Revocation enforcement for HTTP, bounded SSE and live terminal sockets; expired browser returns to sign-in without restarting/cancelling agent work.
- [x] Native integration and local browser journeys; independent backend and frontend reviews. Native Better Auth SQLite tests cover encrypted/verified enrollment, session rotation, no pre-factor session, password recovery retaining 2FA, recovery-code CAS/replay, expired/consumed challenges, failed-attempt limits, foreign origins, ownership isolation, individual/bulk revocation and stale management. A failed factor change during normal session refresh does not revoke other browsers.
- [x] Session fetch coordination prevents poll/focus/reconnect/cross-tab reads from discarding recovery codes during cookie rotation. Delayed-response and failed-request regressions pass. No secret is stored in browser storage.
- [x] Native local workerd/D1 and UI: existing owner/session data survives the additive migration; setup → verify → save codes → second-browser recovery sign-in → revoke that browser → automatic return to login; disable requires password. Native Worker WebSocket 101 and binary forwarding passed; a revoked authorization closed the socket in 4,999 ms. Failed/hung checks fail closed. HTTP rechecks immediately; terminal rechecks every 5 seconds with a 15-second deadline; existing SSE streams reconnect within 60 seconds; browser session polling is 30 seconds.
- [x] Desktop and 390×844 Paper checks, mobile navigation entry, zero horizontal overflow, 44px mobile actions; scoped accessibility audit found no violations (one automated contrast check inconclusive, reviewed visually). All 441 tests across 66 files, typecheck, lint and production build passed; only Input OTP and local QR encoding dependencies were added, retaining the existing locked framework versions.
- [x] Signed PR/main checks, Cloudflare deployment and hosted anonymous authentication boundary passed. In a fresh signed-in production tab, the security panel loaded the native session list, identified the current browser, exposed individual/bulk revocation, and opened the password-confirmed authenticator setup form. The existing owner session and workspace survived deployment. Real-owner 2FA remains off until the owner enrolls; no production factor or session was changed for testing. Complete factor/recovery/revocation mutations were verified with a disposable local account, not the production owner.

References: [Better Auth two-factor](https://better-auth.com/docs/plugins/2fa), [session management](https://better-auth.com/docs/concepts/session-management), installed Better Auth 1.7.7 source. Frontend uses the shared shadcn/Base UI Dialog, Field and Input OTP primitives. QR encoding stays in the browser; setup secrets and recovery codes never enter browser storage, model context or telemetry.

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
| 03 — Files and attachments | Upload images, videos and documents privately; validate size/type/path; preview/download/delete safely; reference assets in a turn; vision uses supported image blocks; video uses explicit frame/transcript extraction. | 03a–03b deployed; 03c verified locally |
| 04 — Reusable skills | Create/edit/attach skills to bots; durable revisions; selected skills enter context; import through the intended Executor source; scoped access and recovery. | 04a and 04b deployed |
| 05 — Tools and approvals | Connect Executor/MCP; assign tools per bot; Allow/Ask/Deny enforced server-side; approval persists across reload/restart; background work cannot bypass approval; revoke access. | 05a and 05b deployed |
| 06 — Browser | Bot browses on Cloudflare; observe and take over in the workbench; authenticated Chromium sessions; Kitesurf for compatible short tasks; session expiry/reconnect and destination controls. | 06a and 06b deployed |
| 07 — Execution and terminal | Isolated fast code execution plus on-demand Linux container; live terminal; files persist across container restarts; bounded time/output/network; cancel and recover. | 07a–07d deployed |
| 08 — Generated apps and inline UI | Bot creates, previews, updates and runs an app; versioned private publication; isolated execution/storage; inline UI uses a bounded renderer; interactions return events to the owning bot. | 08a and 08b deployed |
| 08c — Persistent working objects | Agent creates a project checklist; owner edits tasks inline or in Objects; agent reads current state; history, conflicts, retry receipts and archive/restore survive restart. | Deployed in PR #23; local journey/recovery verified; hosted authentication checks passed |
| 09 — Routines and incoming events | Schedule/pause/delete routines; run with browser closed; authenticated webhook triggers; durable retry/deduplication; notify on meaningful outcomes; respect bot grants and budgets. | 09a and 09b deployed |
| 02d — Different models for different jobs | Account-aware deterministic routing; per-agent job defaults and per-message profiles; durable selection, usage and explicit failure states. | Deployed; hosted routing verified |
| 02e — Independent memory policy and remaining jobs | Pin OptChat summary routes, bound retries, expose explicit recovery, and evaluate labels/extraction/memory/planning choices. | Deployed; hosted memory and recall verified |
| 10 — Delegation | Explicit parent/child tasks; separate child memory/tool grants; bounded concurrency; steer/stop children; deliver completed reports once after restart. | 10a–10b deployed |
| 11a — Automatic durable task planning | Substantial requests maintain a bot-local plan; Activity exposes progress, blockers, evidence and history; compaction, restart, steering and cancellation preserve authority. | Deployed in PR #25; local journey/recovery and hosted authentication checks passed |
| 11 — Activity and recovery | Per-bot/global activity; inspect tool outcomes and approvals; recover interrupted work; expose actionable connection/backup failures; inspect/export memory and workspace. | Deployed in PR #31; hosted isolation, saved history, replay and read-only acceptance passed |
| 12 — Complete product verification | Approved desktop/mobile states implemented; keyboard/accessibility checks; isolation/replay/permission tests; restore proof; secret scan; CI/deploy and hosted acceptance of all journeys. | Deployed in PR #32; hosted checkpoint/output recovery passed; functional build complete |

Each slice gets implementation and proof notes below. Add a slice rather than hiding missing behavior in “done.” `todo.md` remains the detailed OptChat steering/subagent reference; this tracker supersedes its deferral status.

## Acceptance journeys

### Queued priorities after the current video slice (2026-10-11)

The owner asked to finish slice 03c first, then implement the following two requests in order. The subsequent persistent-working-objects request is now the active slice (08c); these two requests remain queued, in their original order, before the remaining roadmap. These are saved requirements, not completed work. The full prompts are retained below.

#### 02c — Native working-context compaction

Enable Pi Durable’s built-in automatic compaction for long-running sessions in durable-pi.

Currently, each new user turn starts a fresh Pi session with an OptChat memory view, but Pi’s automatic compaction is explicitly disabled. A long individual run can therefore accumulate browser output, terminal results, tool calls, and steering messages until it exceeds the available context window.

Keep the responsibilities clear:
- OptChat owns long-term memory, original-message archival, summaries, notes, and retrieval between turns.
- Pi’s native compaction manages working context within an active run.

Inspect the installed Pi Durable implementation and use its supported configuration and hooks. Keep this a focused integration.

Before choosing thresholds:
- Verify the effective context window for our selected model and ChatGPT subscription connection.
- Reconcile Pi’s model catalog with current official provider documentation. Establish whether any difference is intentional, connection-specific, or outdated metadata.
- Do not assume 300k is a universal OpenAI default or increase the configured window solely because the public API advertises a larger maximum.
- Make thresholds model-aware and reserve sufficient capacity for reasoning, output, incoming tool results, and estimation error.
- Distinguish Pi’s harness compaction from OpenAI’s server-side compaction. Establish which mechanism owns active-run compaction and avoid accidentally enabling competing policies.

Verify that:
- Long runs compact and continue successfully.
- Recent steering, user constraints, and pending work survive compaction.
- Original messages and tool results remain available through the existing archive and retrieval mechanisms.
- Compaction summaries do not masquerade as original user messages or create duplicate archive entries.
- Tool-call/result relationships, approval receipts, and execution replay guarantees remain correct.
- A Durable Object restart during compaction recovers safely.
- Existing OptChat memory and prompt-cache behavior remain compatible.
- Switching models cannot leave the run using an inappropriate context budget.

Add meaningful integration coverage using a deliberately small context budget to exercise compaction without an expensive long run. Include native runtime recovery verification where practical. Inspect actual token usage and compaction overhead rather than treating a configured threshold as proof of correct behavior.

Track the work in the existing build tracker, follow our backend domain boundaries, and carry it through the established review and deployment workflow. Report the chosen thresholds and their rationale, plus what was verified locally versus against the hosted app. Then continue the existing roadmap.

Investigation already completed before the ordering correction (no implementation):
- Installed Pi Durable/Pi AI version 1.0.4; app default `gpt-6.1-sol`. Pi's catalog reports 272,000 context tokens and 128,000 maximum output tokens.
- A read-only request through the production account's single credential-refresh owner to `https://api.openai.com/v1/models` returned `context_window: 272000` and `auto_compact_token_limit: null` for the selected model and the other visible GPT-6/GPT-5.6 choices on 2026-10-11. This confirms a connection-specific difference from the public API model page's 1,050,000 maximum. No inference or private conversation was sent. The temporary authenticated diagnostic Worker was deleted after the check; credentials stayed in Cloudflare.
- [Subscription model discovery](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [subscription limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations), [GPT-6.1 Sol API model](https://developers.openai.com/api/docs/models/gpt-6.1-sol), and [provider compaction](https://developers.openai.com/api/docs/guides/compaction) were inspected. The subscription route rejects `max_output_tokens`; do not mistake Pi's configured output budget for an enforced provider cap.
- Supported Pi settings: `enabled`, `reserveTokens`, `keepRecentTokens`, `backgroundTokens`. `beforeCompact` can decline or supply a summary; native `pi.compaction` persists its selection/request and records summarization usage. Preserve native task recovery instead of writing another compactor.
- Critical integration point: Pi event snapshots contain the **active** context after a head marker, while original entries remain in storage. Existing `readPiReply` uses snapshot entries for archive/finalization/display. Recover the committed original transcript through the captured snapshot boundary before enabling compaction, or older entries/receipts can disappear from that projection after a restart.
- Settings are harness-wide with supported getters; active turns already pin their model and reasoning selection. Ensure budgets follow that pinned run, not the newest UI selection. No thresholds have been chosen yet.

#### 11a — Automatic durable task planning

Add automatic, durable task planning to durable-pi’s normal agent execution.

The existing agent should create and maintain a plan while carrying out substantial, multi-step requests. It should proceed autonomously within the user’s request and existing permissions.

This is not a separate Plan Mode. Do not introduce a planner agent, plan-approval gate, or mandatory planning interaction. Ordinary questions and simple actions should remain free of mandatory planning.

Inspect the existing conversation/run lifecycle and installed Pi Durable APIs first. Use Pi’s supported extension, tool, and durable-state mechanisms where they fit. Follow domain-driven design on the backend and feature-sliced design on the frontend.

The plan should contain:
- The user’s objective and relevant constraints.
- Observable criteria for completing the request.
- Concrete steps with pending, active, blocked, or completed status.
- References to completion evidence, such as execution receipts, saved artifacts, or verification results.
- The next action and any blocker.

Expose an update_plan tool so the agent can create and revise its plan during execution. Associate it with the correct bot and logical task, including steering inputs belonging to that task. Establish when a later user message continues an existing task versus starts a new one.

Supply the current plan to subsequent model requests without accumulating repeated full-plan copies in conversation history. Preserve revisions for recovery and inspection. Plans must survive compaction and Durable Object restarts.

Maintain these boundaries:
- Plans never grant permissions or override existing approval requirements.
- Ask the user only when necessary information is missing or an action requires approval.
- Agent-reported completion is distinct from verified evidence. Validate evidence references and ownership.
- Changed requirements or invalidated evidence can reopen completed steps.
- Cancellation remains authoritative; persisted plans must not restart cancelled work.
- Waiting for approval or external results must not become an automatic retry loop.
- Plan updates must not replay completed external actions.
- Once the requested outcome is achieved and appropriately verified, finish without unnecessary repeated checking.

Display the objective, progress, blockers, and evidence in the existing Activity interface using shadcn/Base UI. Keep it synchronized with durable state and usable on mobile. Users can inspect progress without having to manage the plan.

Add meaningful coverage for persistence, restart recovery, steering revisions, cancellation, concurrent or replayed updates, bot isolation, context injection, and completion evidence. Verify a representative multi-step journey and confirm that simple chat requires no plan or approval interaction.

Keep this focused within the existing architecture. Track it in the build tracker and carry it through the established review and deployment workflow. Report local versus hosted verification, then continue the existing roadmap.

### Existing product journeys

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


### 09a deployment completed

PR #20 merged as `3ca33c0`; production workflow `38116403026` succeeded, including hosted authentication checks. Owner/model acceptance remains deferred; native Pi approval/restart coverage and synthetic workerd alarm checks passed locally.

### 09b — Authenticated incoming events

Outcome: an owner can create an Events-only routine or add a webhook to an existing schedule. The Routines workbench provides an endpoint, generates a private key, supports key rotation/revocation, explains the request format and retry responses, and shows event-triggered runs alongside schedules. Keys appear only in the current editor, masked with explicit copy, and are never exposed to the agent or persisted in browser storage. The server stores only SHA-256 digests.

Architecture: Webhooks owns inbound authority and delivery receipts in each bot's SQLite database; Routines owns run admission and budgets. The public Website route resolves the configured owner through D1, strips caller identity/cookies, bounds the body, and forwards through the private service binding. The Agent checks the key before bot synchronization and checks authority again atomically when accepting an event. Accepted payloads are labelled untrusted data in the normal conversation, with existing grants/Ask approvals and the ten-minute routine budget.

Delivery contract: POST JSON object, `Authorization: Bearer YOUR_KEY`, `X-Event-Id` (1–100 letters/numbers/dot/colon/hyphen/underscore). Raw and normalized JSON are limited to 16 KB. 202 accepts one durable run; an exact repeat returns its receipt with 200, including after restart or key rotation. Changed data with the same ID returns 409. Busy returns 429 and Retry-After 60 without accepting a receipt. Unexpected storage/wake failures return safe 503 errors for same-ID retries. A bot retains up to 2,000 event receipts and 2,000 configuration receipts, then explicitly rejects further new entries instead of silently weakening deduplication. No unbounded incoming queue.

Rotation/revocation cancels unadmitted webhook work. An admitted reply may finish; Stop cancels it. Pause/archive blocks new events. All changes use revisions, stable operation IDs and cancellation tombstones. The UI confirms current settings after a mutation/replay before showing a key, and retains recovery controls/navigation locks after uncertain responses. No external service is configured or granted a key automatically. This is a generic bearer-authenticated endpoint, not a vendor-specific signature verifier. Outbound push/email notifications remain outside this slice; results appear in the owning conversation.

Verification:

- 313 repository tests, typecheck and production build passed. Focused tests cover atomic receipt/run rollback, restart replay, key rotation, paused/archived/sibling isolation, limits, cancellation tombstones, unsafe headers, bounded JSON, provider failure/redacted errors, and replay after a lost acknowledgement.
- Review found and fixed compact-number JSON expansion that could corrupt a run, transient database failures classified as 400, and stale key presentation after replay. Regression tests and independent backend/frontend rechecks passed with no remaining findings.
- `scripts/check-webhooks.ts` passed against local workerd via the public route: unauthenticated and wrong-key rejection, configured-owner routing, sibling isolation, dedup/replay/conflicting event IDs, busy retry, normal pending run admission, rotation/revocation, and no key in server responses.
- Browser check: Events routine creation has no date requirement; enable/key-copy/revoke feedback works; a 390×844 layout has no horizontal overflow. Synthetic key revoked after the check. Proof: `slice09b-mobile.jpg` in the task's local workspace-build visualization folder.
- Hosted deployment adds an unauthenticated webhook boundary probe. No authenticated owner/model inference is claimed.

References: [Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/), [Durable Object SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).


### 03c — Private video frame and caption preparation

MP4/WebM uploads enqueue durable preparation in Workspace. The existing private TerminalWorker runs FFmpeg in a separate media container identity with no outbound network or model credentials. Up to six JPEG frames carry their decoded presentation timestamps; supported embedded text captions are retained within an 8,000 UTF-16-unit budget. Originals and derivatives remain private in R2. Files exposes pending/ready/failed states, explicit legacy preparation/retry, timestamped previews and attachment readiness. Pi receives image/text blocks, with explicit sampling and audio limitations.

Proof (2026-10-11):
- 323 tests, typecheck, lint and production build passed. Focused tests cover persistence/reopen, three-attempt retry/backoff, archive/Trash publication fences, legacy upgrades, malformed results, sibling namespaces and maximum four-video attachment/steering budgets. Four six-frame videos fit within the existing image input budget; JPEGs are capped at 24 KB.
- The Linux/amd64 container build runs real FFmpeg regression checks: MP4 embedded captions, long Unicode captions, hostile metadata, sparse and variable-frame-rate timestamps, short WebM, frame byte bounds, invalid media and the ten-minute limit. Python/decoder subprocesses have memory, CPU, file-size and elapsed-time limits.
- Local workerd E2E passed through the actual private service binding, Sandbox Linux runtime, durable extraction and R2: authenticated upload, four correct JPEG frames, original preservation, private preview, sibling/anonymous rejection, Trash fence and restore. Browser verified upload, preview, attachment selection/removal and mobile 390×844 without overflow; no fresh browser errors. No live model or owner conversation used.
- Read-only backend/frontend reviews found and corrected oversized aggregate vision context, timestamp/metadata confusion, Unicode truncation, and busy-container restart retries. Follow-up review passed.
- No new cloud permission or resource; the media container shares the approved four-instance pool. Videos are limited to 8 MB, ten minutes and 4096 pixels per side. Audio speech transcription and image-subtitle OCR are not implemented.
- The owner's complete compaction and automatic-planning prompts are saved above; implementation follows this slice as requested.

03c shipped in PR #22, main `da15fb0`; production workflow `38119148560` passed, including hosted authentication checks.

### 08c — Persistent working objects

Working objects are structured durable information the owner and their agent maintain together, independently of the conversation that created them. First deliver one project checklist: stable object/task IDs, schema version, revision, task title/status/optional due date/notes, compact editable live chat card, full Objects workbench, readable actor/source history and a link to the originating conversation. Future itineraries, decision registers and research collections are extension points, not scope for a generic database builder.

Design first: inspected the approved Paper desktop, inline-app, mobile and token/component states. Added focused Shared checklist / Next task / Review desk explorations and refined the Shared checklist into desktop, mobile, conflict, save recovery, history and archive states. Preserve the Quiet Workroom palette, Geist, semantic shadcn/Base UI primitives and the conversation/workbench relationship.

Persistence decision: installed Pi Durable 1.0.4 exposes `defineDocFamily({ scope: "session" })`, `Session.commit`, typed snapshots and document watches. Cloudflare `PiHarness.pi()` returns one native Harness/Session for the bot; its UI-named sessions are individual Pi conversations. Session-scoped documents therefore outlive per-turn conversations and fit this domain. Use those native documents and atomic commits for the authoritative object, catalog, immutable events and idempotency receipts, with no second editable copy in Apps, chat or OptChat. The existing Apps renderer remains separate and unchanged for existing generated applications.

Acceptance contract:
- UI and typed agent tools call the same Effect application operations; owner/bot boundaries come from authenticated routing, never request-supplied identities.
- Targeted edits use expected revisions; stale writes return explicit conflicts preserving drafts. Stable operation IDs replay the original receipt; cancellation fences uncertain writes.
- Every successful change commits its actor/source event atomically with state. Native context hooks make changed object references available on model requests; checkbox clicks never enqueue a run. History and pending change state survive restart.
- Archive/restore only, no permanent deletion. Task IDs are never reused. Archived objects and tasks remain inspectable.
- Verify native Pi tool creation, user edits, later agent reads, cross-bot isolation, concurrent writes, lost-response retry, native SQLite reopen and local workerd recovery. Hosted deployment evidence remains distinct from owner/live-model acceptance.

Delivered:
- `src/objects` owns typed checklist contracts, targeted domain edits, Effect operations, native Pi persistence, HTTP routes and tools. `src/features/objects` owns the shared chat/workbench projection, editing, conflict comparison and recovery. No new Cloudflare resource or permission.
- `create_checklist`, `read_object`, `update_checklist` and `list_objects` use authenticated bot scope. Field changes, current revision and retry receipt commit atomically. Each event preserves actor, source surface and originating tool/turn where applicable.
- Current references are injected ephemerally on each native GenerationTask request, never appended as chat or OptChat originals. A durable sequence watermark records changes offered to successful model requests. User clicks start no model run.
- Drafts use targeted patches, exact expected revisions and operation IDs retained before sending. Cross-view conflict recovery settles the original draft, including repeated conflicts. Lost outcomes require explicit retry or server-confirmed cancellation. Object and task archive/restore retain IDs and history.
- Native document tools alone opt into interrupted dispatch recovery. The original grant must remain unexpired and at the same policy revision; cancellation and bot/run fences still apply. External actions retain their existing unknown-outcome interruption fence. Oversized reads use complete JSON task pages, measured after escaping, under 64,000 characters.
- Paper boards 32–35 cover exploration, live workspace, conflicts/recovery/history and mobile. [Design file](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-1-0). Workbench and compact live card use existing shadcn/Base UI primitives and semantic tokens.

Verification on 2026-10-11:
- Full local `pnpm verify`: typecheck, 337 tests across 45 files, client/server build. Lint passed. New files are included in the pre-push tracked-file secret scan.
- Native Pi + deterministic provider journey: agent tool creates the checklist, UI HTTP operation edits it, a later native conversation reads the current edited state, no approval or automatic run for the UI change, one ephemeral reference projection and no duplicate transcript entry.
- Native SQLite reopen and in-flight tool recovery: interruption before/after commit; retry retains one object/event; revoked/expired grants and cancellation cannot start new work. CAS races, isolation, atomic batch rollback, archive/restore, paged history, pending change watermark, mutation cancellation and large escaped tool pages passed.
- UI store against native persistence: response lost after commit, browser-state recovery without automatic replay, same-operation retry, repeated conflicts with shared original-draft settlement, explicit cancellation, stale response ordering and history preservation passed.
- Actual local authenticated workerd gateway: create/edit, sibling-bot/anonymous/unowned rejection, two concurrent writers, retry, archive/restore and tool-ID impersonation rejection passed. Stopped and restarted the Alchemy Worker process; the checklist, five history events and original revision-one receipt remained intact (`scripts/check-objects.ts --after-restart`).
- Browser: direct creation, task/date/note editing, completion, a competing editor's conflict and explicit reapply, history, archive/restore and reload passed. Mobile 390×844 has no horizontal overflow. No new browser errors after reload; earlier development-only hot-reload errors came from replacing the in-memory store shape mid-edit.
- Independent read-only backend/frontend reviews passed after fixing recovery grant fences, oversized tool output and cross-view conflict draft loss. Hosted authentication probes include object read/mutate/cancel endpoints. Production deployment and live owner/model acceptance are reported separately; local native provider fixtures do not claim ChatGPT inference.

Next: 02c native working-context compaction, then 11a automatic durable task planning. Their complete prompts remain above.

08c shipped in [PR #23](https://github.com/cill-i-am/durable-pi/pull/23), main `5440894`; [production workflow 38121058346](https://github.com/cill-i-am/durable-pi/actions/runs/38121058346) passed deployment and hosted object authentication probes. Owner/live ChatGPT acceptance remains unclaimed.

### 02c — Native working-context compaction

Installed Pi Durable/Pi AI 1.0.4 owns active-run compaction. OptChat continues to own original-message archival, summaries, notes and retrieval between turns. The configured `openai/gpt-6.1-sol` resolves to 272,000 context tokens and 128,000 maximum output tokens, using the direct Responses endpoint with ChatGPT subscription OAuth. [Pi’s current catalog](https://pi.dev/models/openai/gpt-6-1-sol) matches this; its [generator](https://github.com/earendil-works/pi/blob/main/packages/ai/scripts/generate-models.ts) intentionally uses the short-context tier. [OpenAI’s API model page](https://developers.openai.com/api/docs/models/gpt-6.1-sol) advertises a 1,050,000 maximum. The earlier authenticated `/v1/models` diagnostic for this app’s subscription returned `context_window: 272000` and `auto_compact_token_limit: null` on 2026-10-11; its temporary Worker was removed. Keep the verified connection/catalog budget, rather than interpreting the API maximum as this grant’s entitlement.

Policy: compact above 112,000 estimated/measured context tokens for the current model. Reserve 160,000: its 128,000 reasoning/output allowance plus 32,000 for ordinary incoming tool results, ephemeral object references and estimation error. Keep approximately 20,000 recent tokens verbatim, with native safe cut selection preserving tool-call/result relationships. This is conservative headroom, not a guarantee that an arbitrary oversized single input or parallel tool batch will fit. The [subscription transport rejects `max_output_tokens`](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations), so that allowance is not an enforced output cap.

`src/agent/compaction.ts` derives every native policy read from the active turn’s pinned model, including after restart. Headroom scales as one eighth of its window, capped at 32,000; reserve is capped at three quarters of the window so smaller models retain usable input space. Recent retention is capped at 20,000 and one third of remaining input space. `backgroundTokens: 0` keeps compaction owned by the active run, so a background summary cannot inherit a subsequent run’s model budget. Native summary selection, prompt, checkpoint/retry, usage accounting and cancellation remain intact. [OpenAI server-side compaction](https://developers.openai.com/api/docs/guides/compaction) remains disabled; there is one active-run compaction policy.

Compatibility fixes: native event snapshots contain only active context after a head marker. The conversation adapter now pages immutable original history through the captured snapshot tail for archival, settlement and display, excluding `pi.compaction` projections. Receipt mappings still distinguish actual user submissions from synthetic summaries; stable archive sources deduplicate replay. Cached Activity and fallback answers are bounded below SQLite row limits, with explicit notices for older messages/tool results; authoritative native and OptChat originals remain complete. The model adapter now respects the native summarizer’s `cacheRetention: none`, while ordinary OptChat requests retain the stable cache key and explicit memory breakpoints.

Verification on 2026-10-11:
- 345 repository tests, typecheck, lint and production build passed. Focused tests cover continued multi-tool execution, steering/constraints/pending work, complete original tool retrieval and duplicate-free archive, safe tool pairing, unchanged approval receipts, native SQLite restart during summary generation, cancellation across another reopen, object-context injection without transcript copies, and pinned model selection across queued tasks/restart.
- Deliberately small native window: 8,192 tokens; reserve 3,072; recent retention 1,706. The deterministic provider journey made nine normal requests and three native summaries, with 5,054 reported summary input tokens and 407 output tokens (5,461 of 35,226 aggregate fixture tokens). Native usage equals normal generation plus summarization usage. These are measured synthetic-provider accounting values, not OpenAI tokenizer/billing or live summary-quality evidence. Both uninterrupted and mid-summary restart journeys returned the same totals; 23 originals remained while the active context held five entries.
- Actual local workerd/Agents PiHarness recovery: an isolated credential-free Alchemy fixture paused at a durable blocking compaction after four tools. The Worker process was stopped and restarted against the same SQLite storage; it finished all eight unique tool calls exactly once, with 21 original entries and seven active entries. No production fixture or resource was created. Node-native tests additionally cover approval and cancellation recovery.
- Subscription payload test exercises the installed OpenAI adapter with a synthetic transport: no server-side `context_management`, unsupported output cap omitted, summary cache key absent, normal cache key/breakpoints and reasoning replay preserved. No network inference.
- Independent read-only review found and fixed the long-run display cache row-size problem. A 100-tool Unicode regression verifies byte limits and retained original content; focused re-review passed. Hosted deployment checks are separate; no hosted long-running ChatGPT conversation or live summarization-quality check is claimed.

Next: 11a durable task planning. The follow-on Paper fidelity goal below starts after the current build goal is complete.

02c merged in [PR #24](https://github.com/cill-i-am/durable-pi/pull/24), main `9b88ca1`. Both checks passed on signed head `d93acd9`; [production workflow 38122209355](https://github.com/cill-i-am/durable-pi/actions/runs/38122209355) passed, including production Alchemy deployment and the hosted authentication-boundary checks. No live hosted model inference is claimed.

### 11a — Durable task planning

The complete owner request remains in the acceptance section above. Plans belong to normal execution, with no separate mode, planner agent or plan approval gate. They describe work and evidence; Access and Conversations continue to own permission and cancellation.

Implemented a Planning bounded context with native Pi session-scoped documents for tasks, revisions, root-turn bindings and idempotent update receipts. One atomic commit owns all four. `update_plan` explicitly selects new work or continuation of the same bot's logical task; steering inherits the root. Stable steps record observable criteria, constraints, next action, blockers and evidence references. Requirement changes and invalidated evidence reopen completed steps. Cancelled tasks remain cancelled, including after restart, and saved plans schedule no work.

The native `GenerationTask.beforeRequest` hook supplies a fresh projection without appending it to original history. Updates return small durable receipts. `read_plan` pages complete JSON values below 40,000 UTF-8 bytes, under Pi's native 50 KiB tool-output limit. List and detail cursors preserve all content, including unusually escaped strings. Task storage is bounded to 200 tasks per bot, 1,000 ordinary revisions per task and 100 contributing root turns; cancellation and evidence invalidation can still be recorded after the ordinary revision limit.

Evidence resolves through the owning bot's Access, Execution, Workspace, Apps and Working objects operations. IDs, current revisions, ownership and recorded outcomes are checked; labels distinguish that source validation from the agent's semantic completion claim. Failed legacy execution receipts cannot validate completion. Checklist evidence reads within the existing Pi transaction, avoiding a second snapshot transaction. Stop revokes/aborts execution before fallible plan reconciliation. Approval waits and external blockers never become automatic retries; existing completed action receipts remain authoritative on replay.

Activity uses shadcn/Base UI and the approved Paper layout direction. The read-only inspector shows objectives, constraints, completion criteria, step progress, blockers, next action, evidence and durable revision history. Actual pending approvals link back to the existing chat controls. Polls and reconnects reject stale bot/task responses; history remains navigable when new revisions arrive. Full visual fidelity remains the separate follow-on goal.

Verification:
- Native SQLite/provider fixtures exercise ordinary multi-step tool execution, exactly-once action receipts, simple chat without a plan or approval, atomic concurrent/replayed updates, root-task continuation, steering revisions, cancellation before creation and after restart, bot isolation, invalidated evidence and revision history. A deliberately small 8,192-token model compacts during execution; the current plan remains available once per request, absent from original transcript copies, and survives reopen without starting work.
- Native tool tests page maximum escaped summaries and detailed plans without invalid JSON or lost entries. Cold checklist evidence after native restart does not deadlock; a later owner edit reopens the completed step once. Failed code/command receipts remain invalid.
- Real local workerd verified authenticated reads, an owner edit through the shared checklist operation, durable evidence invalidation (plan revision 12 → 13), cross-bot 404 and history pagination. Stopping and restarting the whole local process preserved that state. Initial plan data was seeded through native Pi application operations into a synthetic bot; this is not a live ChatGPT-generated journey.
- Browser checked Activity at 1440×900 and 390×844, evidence disclosure, older revisions and refresh. No horizontal overflow at 390px or fresh browser errors. Screenshots are local artifacts, not hosted proof.
- 355 tests, typecheck, lint, production build and tracked-file secret scan passed. Independent read-only backend/frontend reviews closed after correcting cold evidence reads, cancellation ordering, failed legacy receipts, native output pagination, steering delivery identity and live history pagination. Native delivery receipts distinguish consumed inputs from bounded fallback text, so quoted prior text cannot acknowledge a new steer and a large already-delivered batch cannot leave planning blocked. PR #25 merged to main `c3067fe`; both exact-head checks passed. [Production run `38123979921`](https://github.com/cill-i-am/durable-pi/actions/runs/38123979921) passed checks, Alchemy deployment and hosted authentication probes, including plan routes. Hosted authenticated owner/model acceptance remains deferred; local faux-provider coverage does not establish model planning quality.

Next: delegation (10), the remaining activity/recovery work (11), then complete-product verification (12).

### 10a — Request-owned native delegation (implemented; deployment pending)

Grounded in Paper’s “Agents / delegation & parallel work” artboard and the installed Pi Durable 1.0.4 ownership/commit APIs. Start with a complete request-owned journey: the owner asks for parallel help; the bot delegates up to three bounded research/drafting tasks; each child has its own durable native conversation and explicit read-tool set; Activity exposes work, results, steering and Stop; the parent receives the combined result once. Children cannot spawn children. Child transcripts and reasoning remain outside the parent's OptChat archive; only the combined report enters it through the parent tool result.

Use native task ownership and stable submission IDs for reuse/recovery, rather than a second execution scheduler. The parent stays active while this first increment's children work, so existing permission, pinned-model context budgets and cancellation authority remain attached to that request. Stop must reach children; replay must reuse their committed outcome. Read-only child tools can query only the owning bot's explicitly supplied memory/files, subject to existing grants. Shared context and tool limits remain visible in Activity.

10b will add background groups and recoverable report delivery when the parent is idle, using a durable mailbox integrated with normal turn admission. It must separately prove parent cancellation fences, bounded wakeups, loop prevention and exactly-once admission; native background ownership intentionally survives ordinary parent abort, so the example cannot be copied without those product rules. Cross-bot delegation or sharing must be explicit and preserve each bot's data and grants. These background/cross-bot capabilities are not delivered by 10a.

References inspected: [Pi native ownership](https://github.com/earendil-works/pi/tree/main/packages/durable#abort-and-subagents), [background child/report example](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/23-subagent-background.ts), and [Cloudflare Pi integration](https://developers.cloudflare.com/agents/harnesses/pi/). Local implementation and verification are recorded below; production acceptance remains pending.

### Follow-on goal — Match the approved Paper implementation

Requested by the owner on 2026-10-11: once the current build goal is complete, create a separate goal to make the product UI match the [approved Paper implementation](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-1-0) as closely as possible. This follows the current goal; it does not replace the remaining compaction, durable planning or roadmap work.

Use Paper as the visual and interaction reference. Audit every implemented screen and state, then close differences in layout, spacing, typography, colors, borders, component composition, navigation and responsive behavior. Keep shadcn/Base UI primitives and the established frontend feature boundaries. Cover authentication, agent navigation and chat, composer/attachments/steering, tools and thinking, workbench panels, activity, approvals, recovery, working objects and mobile states.

Acceptance: compare product screenshots with the corresponding Paper artboards at matching desktop and mobile sizes; record and resolve material differences, including loading, empty, error, conflict, archived and recovery states. Verify keyboard and touch interactions as well as visual fidelity. Preserve implemented behavior and accessibility. Track any deliberate departures and their reasons, carry changes through the established review/deployment workflow, and distinguish local screenshot verification from hosted verification.


## 02d — Different models for different jobs

Owner request (2026-10-11), retained verbatim:

Implement “different models for different jobs” in Durable Pi as an end-to-end feature. Add it to the existing work tracker and deliver it in small, working slices.

Keep the existing Cloudflare architecture, Effect backend, domain-driven design, and feature-sliced frontend using TanStack Start and shadcn/Base UI. Inspect the current implementation and installed Pi APIs before changing anything.

Objective

Each job should use an appropriate model and reasoning effort, with clear defaults, user overrides, durable execution, and visible usage. Use my existing ChatGPT subscription connection where supported.

Initial model assignments

| Job | Model ID | Reasoning effort |
|---|---|---|
| Conversation titles, labels, classification | gpt-6-luna | low |
| Structured extraction from text or images | gpt-6-luna | medium |
| Routine summaries and memory compaction | gpt-6-luna | medium |
| Everyday conversation, research and tool use | gpt-6.1-sol | medium |
| Complex implementation and multi-step troubleshooting | gpt-6.1-sol | high |
| Deep planning, architecture and difficult synthesis | gpt-6-astra | high |
| Requested critical review of complex work | gpt-6-astra | high |
| Explicit “think harder” override | gpt-6-astra | xhigh |

These are initial product defaults to evaluate, not claims that one model always performs best.

Routing

- Start with explicit job types and deterministic routing. Do not add a separate model call just to choose a model.
- Resolve settings in this order: explicit job override, agent-specific job settings, application defaults.
- Ordinary chat defaults to GPT-6.1 Sol at medium effort.
- Select Astra when the user chooses Deep, or when a clearly defined deep-planning/review job is created. Do not silently upgrade every difficult-looking message.
- Routine background jobs retain their own assignments independently of the conversation model.
- Direct database queries, checklist edits and other deterministic operations should not require inference.
- Do not introduce subagents solely to implement model routing.

Account access and capabilities

- Discover available models through the signed-in account’s supported model-list endpoint. Pi’s bundled catalog alone is not proof of access.
- Validate model ID, reasoning effort, input modalities and tool support against account access and the installed provider implementation.
- Use Pi’s supported Responses API integration and reasoning options.
- Never silently clamp an unsupported effort, substitute another model, or switch to separately billed API credentials.
- Show unavailable profiles clearly and let the user choose an available replacement.
- Keep credentials server-side and preserve the existing refresh and account-isolation behavior.
- Verify the subscription integration’s eligibility for this Cloudflare deployment before expanding its use. Report any unresolved restriction precisely.
- Image input does not imply native audio/video support; retain existing media-processing boundaries.

Durability and correctness

- Persist the resolved model, effort and routing-policy version with each job.
- Configuration changes affect new jobs; resumed jobs retain their original selection.
- Preserve conversation context, working-object access, permissions and tool history across model changes.
- Use existing durable execution and idempotency mechanisms so retries or model changes cannot repeat completed external actions.
- Handle authentication failures, rate limits, interrupted streams and incomplete responses explicitly. Do not present partial output as a completed job.
- Bound retries and background concurrency. Avoid automatic retry loops across models.
- For memory compaction, preserve source references, decisions, unresolved tasks and uncertainty. Keep the previous valid memory until a replacement passes validation.

User experience

- Add Auto, Fast, Balanced and Deep choices to the composer:
  - Auto: use the configured job policy.
  - Fast: gpt-6-luna, low.
  - Balanced: gpt-6.1-sol, medium.
  - Deep: gpt-6-astra, high.
- Offer the xhigh Astra override in advanced controls.
- Show the actual model and effort alongside the selected profile.
- Let agent settings override individual job assignments.
- Show the model, routing reason, duration, reported token usage and outcome in Activity.
- Identify when ChatGPT plan usage is active. Do not invent subscription-credit estimates from API dollar prices.
- Keep controls unavailable when their required model is unavailable, with a useful explanation.

Verification and delivery

- Test routing precedence, capability validation, unavailable models, durable resume, account isolation and failure handling.
- Verify the selection travels from the UI through durable job creation to the actual provider request.
- Compare representative extraction, memory and planning tasks across the proposed defaults. Check factual fidelity and task completion, not just latency.
- Use small live checks where authorized and distinguish those results from mocked tests.
- Deliver one complete slice first: per-agent default plus per-message override, persisted model selection, real inference and Activity reporting.
- Then wire background jobs and the remaining profiles into the same policy.
- Update the work tracker with evidence, limitations and any justified changes to these defaults.

Delivery sequence: first conversation defaults and one-message overrides with persisted routing and Activity; then independent background assignments and representative quality checks. Delegation remains queued behind this shared model policy.

Eligibility preflight: OpenAI’s [overview](https://developers.openai.com/siwc/token-sharing-open-source) documents OSS/local apps and directs remotely hosted apps to a separate interest process. Its [VM guide](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms) permits protected same-user credential transfer with a stable host identity and one refresh owner. Neither establishes that Cloudflare Workers is an eligible self-hosted VM. Existing successful authentication is not eligibility evidence. The owner confirmed continuing with Pi subscription access and explicitly ruled out API fallback. Pi documents remote/headless OAuth and Cloudflare documents Pi Durable hosting; neither supplies deployment-specific registration eligibility for this Workers app. Record that remaining documentation ambiguity separately from account access and small authorized technical probes. No API-key fallback.

### 02d first slice — Conversation routing

Implemented per-agent conversation/implementation/planning/review defaults, one-message Auto/Fast/Balanced/Deep and advanced xhigh, account capability discovery, durable route/version/window pins and provider-request Activity. Steering retains its active run's model. Retrying an interrupted run retains its original route and native execution identity, including legacy turns. Account model access is intersected with the installed Pi Responses adapter, supported reasoning, image and tool capabilities. Unsupported choices fail explicitly; neither API credentials nor environment fallback can supply inference.

Activity records each actual attempt, purpose, requested and reported model, effort, routing reason, duration, terminal outcome and provider-reported input/cached/output tokens. Cached input is a subset of input. Missing usage remains unknown. Partial responses are not completed jobs; interrupted observations do not schedule execution. The existing bounded native retry policy remains in charge; provider-level retries are disabled.

Verification on 2026-10-11:
- 368 tests, typecheck, production build and lint passed. Real installed Pi harness plus SQLite proves UI command → durable route → Responses payload, restart during inference, stable model after settings change, and no replay of an already completed tool action. Fixtures cover API-key refusal, unavailable effort/account access, truncated/incomplete/failed streams, partial usage, pre-provider auth errors, legacy pins, bot isolation and observation recovery.
- Local workerd gateway verifies owner authentication, cross-origin rejection, scoped Activity and unavailable subscription behavior without any model credential. Browser controls were checked with an explicitly synthetic catalog; the real credential-free error state was also checked. The settings dialog fits 390×844 without horizontal overflow. This is UI evidence, not live model access.
- Independent backend/frontend reviews closed after checking shared catalog isolation from active-run budgets, admission fences after async discovery, late settings acknowledgements, steering presentation and observation failure handling.
- Read-only production subscription discovery reported 272,000-token windows for Luna, Sol and Astra and no server auto-compaction limit. Small direct subscription Responses probes completed on Luna/low, Sol/medium and Astra/high, each reporting 61 input and 20 output tokens. These prove transport/account access only, not comparative task quality or the full hosted app journey. Temporary diagnostic Workers were deleted.

Deployed in PR #26 as `dfd7f1f`; production run `38125366175` passed checks, Alchemy deployment and hosted authentication probes. Hosted synthetic-bot admission and account discovery passed, but the first app journey exposed a wake/admission ordering race: the pump could finish empty while catalog discovery yielded, leaving the subsequent durable turn queued with no provider request. The test bots were archived and temporary diagnostic Workers deleted. PR #27 corrected this race and deployed as `c665f3f` in production run `38125981804`.

Correction: arm the conversation wake after durable admission, and re-arm an idempotent submission replay if an earlier alarm acknowledgement failed. Three production-method regression tests exercise delayed discovery, failed wake/replay without duplicate admission, and bot archival during discovery. Platform constructors are stubbed; the conversation/workspace SQLite adapters are real. No provider call is needed for this regression.

Hosted verification after the correction: a temporary bot completed Auto on Luna/low while its default was changed to Sol/medium, then completed an explicit Deep request on Astra/high. Activity reported the requested and actual models, completed outcomes and real tokens (Luna 5,402 input / 9 output; Astra 5,434 input / 10 output; cached input 0 for both). Replaying the original admission returned `accepted:false` and left exactly two provider attempts. Neither simple request created a plan or called tools. This exercised the deployed service gateway, bot admission, native Pi runtime and subscription; the authenticated owner browser was not used. The bot was archived and diagnostic Worker deleted. One earlier probe completed Luna but encountered a transient diagnostic Worker 404 before Deep; the final fresh probe passed fully.

Next, 02e wires independent background assignments into the same policy and evaluates representative extraction, memory and planning tasks. Native active-run compaction continues to use Pi's pinned working model; OptChat summaries are separate memory jobs. Background model policy and quality comparisons are not delivered by this first slice.

### 02e — Independent memory jobs

OptChat's immutable summary ranges own their source and result. A bot-local routing record pins model, effort, policy version and the first verified context budget for each range, separately from conversation settings. Explicit retry retains prior route revisions and creates a new revision using the current memory default; automatic recovery never substitutes a model. Pi's native active-run compaction retains the working model because its installed supported policy has no independent summarizer-model option; this preserves native checkpoint/recovery ownership.

Summary work keeps the existing eight-slot concurrency bound and five-request byte-budget feedback. Three unsuccessful groups pause a range. A durable 15-dispatch ceiling per route revision also bounds repeated runtime interruption. A response that still exceeds 512 bytes is rejected; original messages and valid child summaries remain authoritative and readable. Memory exposes paused ranges and a deliberate retry with the current memory setting. A chat waiting for paused memory fails with an actionable recovery message rather than continually waking an unavailable summary.

Titles/labels and structured extraction are explicit composer job types with Luna/low and Luna/medium defaults. File parsing, PDF extraction, video preparation, object edits and database reads remain deterministic. This does not introduce an automatic title rewrite, background classifier, OCR service or native audio/video inference. Deployed in PR #28 as `2902fc8`; production run `38126710401` passed checks, Alchemy deployment and authentication probes. Hosted verification completed below.

Local verification: 378 tests, typecheck, lint, production build and staged-file secret scan pass. The installed Responses adapter receives the independent Luna/medium memory assignment even when conversation settings use Astra/high, and Activity records terminal usage. SQLite reopen tests cover route/window pins, dispatch ceilings, explicit revisions, replay identity, bot isolation and original retention. Production-method tests cover wake acknowledgement loss, cancelled catalog discovery, and stale concurrent retries; only missing authoritative-view summaries block chat. Independent backend/frontend reviews closed after these corrections. A 390×844 paused-summary fixture fits without horizontal overflow; simulated lost responses retain the same retry ID through sheet close/reopen. These are local tests, not hosted background inference.

Small live comparison (2026-10-11): six direct subscription Responses calls from a temporary Cloudflare Worker, using synthetic inputs. Extraction requested project owner, corrected budget/date, unconfirmed due-date status and an unknown accessibility detail. Memory requested a ≤512-byte summary retaining numbered sources, corrected decisions, pending draft/venue confirmation, uncertainty and approval before payment. Planning requested a ≤220-word JSON→SQLite migration plan with stable IDs, no lost writes, ≤60-second write pause and rollback/acceptance evidence. These calls assess output quality separately from app integration. No tools executed; the Worker was deleted.

| Task | Model / effort | Reported input / output tokens | Duration | Result |
|---|---|---|---|---|
| Extraction | Luna / medium | 111 / 46 | 2.69 s | Valid JSON; required facts and uncertainty retained |
| Extraction | Sol / medium | 111 / 116 | 5.98 s | Valid JSON; required facts and uncertainty retained |
| Memory | Luna / medium | 153 / 129 | 4.28 s | 270 bytes; corrected facts, source refs, approval and unfinished work retained |
| Memory | Sol / medium | 153 / 75 | 5.12 s | 288 bytes; same required fidelity checks pass |
| Planning | Astra / high | 100 / 622 | 26.39 s | Cutover, write journal, crash evidence, rollback and feasibility gaps covered; 222 words |
| Planning | Sol / medium | 100 / 501 | 22.38 s | Same core acceptance coverage; 225 words |

All six reached `response.completed`; cached input was zero. Aggregate usage was 728 input and 1,489 output tokens, including reported reasoning. Both plans slightly missed the requested 220-word cap. This one-case-per-task comparison does not establish a universal quality/latency ranking: keep the requested initial defaults and require explicit Deep selection. Native working-context compaction stays on the run’s pinned model as described above. No API-priced subscription estimates or API-key fallback.


Hosted 02e acceptance: a temporary bot completed a longer corrected-facts request on Sol/medium while its independent memory job used Luna/medium. The summary completed in 4.05 seconds with 5,046 reported input / 105 output tokens (cached input 0). Memory reached a settled view before the follow-up; Sol then correctly returned the owner, corrected EUR 2,400 budget, tentative 2026-10-20 target, unconfirmed ramp, deposit-approval requirement and unsent draft. The two conversation attempts reported 5,549 / 58 and 5,544 / 48 input / output tokens. Replaying the first admission returned `accepted:false` and kept one provider attempt for that conversation. No tools or plan were created for the simple checks. The bot was archived and Worker deleted. A preceding diagnostic route returned a transient non-JSON 404 before bot creation; a read verified no orphan bot existed. Hosted runtime restart and failure-retry injection were not performed; those remain local deterministic/native tests.

10a implementation is now active. The approved Paper delegation workbench was re-read with unchanged design tokens. Foreground children inherit the parent request's pinned model, effort and context budget: installed Pi's compaction policy is harness-wide, so heterogeneous concurrent child budgets cannot safely borrow a mutable global policy. Use native child ownership and commits, at most three research/drafting children, explicit read tools, no recursive spawn, existing approval receipts, inspectable native child transcripts, and parent-authoritative Stop. Background delivery and cross-bot sharing remain 10b. The full Paper-fidelity goal remains after the complete product build.


#### 10a implementation and local verification — 2026-10-11

Native Pi task ownership, conversations, submissions and session-scoped documents now own foreground delegation. `delegate_tasks` uses the existing Ask/Allow/Deny gate. One group per parent request, at most three children, no recursive spawn, explicit read-tool subsets, inherited pinned model/effort/window, a durable 12-dispatch-intent limit per child, a ten-minute group deadline and eight owner steering inputs per child. Children cannot write objects, modify plans, run browser/terminal actions, or call external services. Full native transcripts stay inspectable; only the combined report enters the parent tool result and OptChat archive. This does not add background or cross-bot sharing.

The existing provider payload hook enforces child ownership and budgets immediately before dispatch, including native compaction and resumed requests. It uses the native provider session identity even when downstream prompt caching uses the bot cache key. Native usage counters appear in Activity; failed/unknown usage is not estimated as billable API spend. Text-only shared references exclude image/video bytes and retain file identifiers. Parent steering is offered fresh on normal child requests without adding repeated copies to native history. A reference view exceeding 64 KiB is replaced by an explicit retrieval/parent-reconciliation instruction; children must not infer missing visual content.

Controls commit their identity and intent before delivery. Concurrent callers drain the same saved per-child prefix, native request IDs deduplicate admission, and the latest native answer entry determines the report. Stop and deadlines remain authoritative. Runtime interruption cancels waiters, not persisted child ownership. A finished group does not resume model work on inspection or exact replay.

Activity follows the Paper delegation hierarchy using shadcn/Base UI: parent objective, child status/brief/tools/usage, results, steer/Stop, steering history and paged native transcripts. Unknown acknowledgements retain their original payload/ID through close/reload; authentication failures do not discard them. Latest transcripts poll while visible; older pages keep their position.

Verification:
- Ten installed-native-Pi/SQLite scenarios cover completion, reopen, child/parent Stop, steering and steering across restart, distinct out-of-order delivery, deadlines, dispatch ceilings and deliberately small-window compaction. Native root history contains one combined result; child history remains separate. Exact completed replay does not dispatch again.
- Installed Responses adapter tests verify original-session guard identity with a shared cache key, blocked compaction dispatch, and cancellation during account validation. Schema/HTTP/recovery tests cover tool escalation, duplicate briefs, bot-local lookup, media exclusion, uncertain controls and late acknowledgements.
- Real local Cloudflare workerd + PiHarness: stopped/restarted the runtime with two model requests suspended and a saved steer. Group 12 retained children 15/23, both completed, the first incorporated the steer, and the parent recorded exactly one tool result. Five synthetic provider attempts were observed (initial two, recovered two, one steering continuation); no owner credential or live model was used.
- Browser fixture at 1440×900 and 390×844: inspected hierarchy, lost response → close/reopen → exact retry → acknowledgement cleanup, live transcript updates and Stop availability while a steer is uncertain. Mobile viewport/page were 390 px and the sheet was 389 px with no horizontal overflow. Temporary request fixtures were removed and the viewport restored. This UI fixture does not claim hosted inference.
- 394 tests across 58 files, typecheck, lint and production build passed.
- Independent read-only backend/frontend review found and corrected encoded-media context, concurrent control ordering/stale answer selection, expired-login acknowledgement loss and stale open transcripts; focused re-review is clear.

Production deployment, hosted authenticated delegation and observed subscription usage are reported separately after CI. Remaining work: 10b background groups/mailbox, 11 activity/recovery completion, 12 full product verification, then the saved Paper-fidelity goal.


10a deployed in PR #29 as `4ccba9f`; production run `38128495310` passed check, deployment and hosted authentication probes. The hosted synthetic-bot journey ran two tool-free children through the subscription connection, inheriting Luna/low and a 272,000-token window. Both returned their required markers, the parent produced one combined report, and replaying the original admission returned `accepted:false` with no extra conversation requests. Each child made one request: 244 input / 52 output and 244 input / 81 output tokens. The parent used 5,782 / 79 and 5,931 / 13 input / output tokens; its continuation reported 5,632 cached input tokens. The independent memory summary used Luna/medium, 5,392 input / 99 output. All five observed attempts completed. The synthetic bot was archived and temporary diagnostic Worker deleted. No hosted restart or logged-in owner browser is claimed.

#### 10b — Background drafting and recoverable reports

The first background increment accepts up to three independent drafting/analysis briefs using an explicit, bounded text reference snapshot and no tools. Foreground 10a retains its selected read tools. Background work does not borrow a later conversation's permissions or memory. No cross-bot sharing is introduced.

Use one binding-only Durable Object and stock PiHarness per group. Every child shares the group's immutable model/effort/window pin; changing the conversation model cannot alter its working-context policy. Native Pi documents, submissions and transcripts own group execution. The owning bot persists the handoff and mailbox identities; these protocol records do not schedule a second model execution.

Normal parent completion allows accepted background work to finish. Explicit Stop, failed/cancelled parent, archived bot, deadline and dispatch limit fence execution and report admission. Report delivery uses a stable internal conversation operation, distinguishes the report from original user input, and cannot delegate recursively. Lost acknowledgements reuse the same identifiers. Group inspection never restarts finished work.

The installed `openPiSessionStore` supports prefixes, but stock PiHarness fixes its capability name and store prefix. Installing two in one Lifecycle is unsupported. A separate group DO preserves the native wake/recovery bridge rather than introducing another execution scheduler. This is a new namespace in the existing private Worker; existing resource IDs and credential ownership stay stable.

Local verification: 409 tests across 60 files, typecheck and production build passed. Five installed native Pi/SQLite scenarios exercise finish, reopen, Stop, steering and deadlines. Mailbox tests cover same-transaction admission/acknowledgement rollback, unchanged model pins, deadline races, bounded transport retries and trusted report provenance through repeated retries. A production-host regression delivers a parked report after a later foreground turn fails on blocked memory. Independent backend/frontend review is clear after fixing that wake, late terminal acknowledgements and retry provenance.

Real local Cloudflare workerd was killed with two native requests suspended and a saved steer, then restarted with the same SQLite store. Children 8/14 and the 8,192-token test window survived; both completed and the first applied metric-unit steering. Five synthetic provider starts were observed (two initial, two recovered, one steer continuation), with reported child usage 328/16 and 196/7 input/output tokens. Replaying the saved steer returned `accepted:false` without another start. The probe used no subscription credential.

Activity fixtures at 1440×900 and 390×844 expose results, usage, steering, transcript and independent group Stop/reconnect actions. An intentionally lost reconnect acknowledgement retained its operation ID; another retry reused it, while Stop remained available and acknowledged separately. The mobile page had no horizontal overflow. Fixtures were removed. Hosted tool admission, report completion and subscription usage remain deployment acceptance checks; hosted restart is not claimed.


10b merged in PR #30 as `eead3f2`. Exact-head CI passed after terminal-history regressions were added: deadline cancellation persists before abort/seal, while completed groups survive later deadlines and delayed Stop. Production run `38129899345` passed check, Alchemy deployment and hosted authentication probes.

10b hosted acceptance: a synthetic bot started two tool-free children through `background_tasks`, immediately acknowledged them, then received exactly one internally identified report. Both children returned their required markers using Luna/low and a 272,000-token window, even after the bot's foreground default changed to Astra/high. Each child made one request and reported 248 input / 8 output tokens. The original root attempts reported 5,960/75 and 6,106/9 input/output; the second had 5,632 cached input. The report turn used the original Luna/low pin, no tools, and 2,341/13 input/output. Three observed independent memory requests used Luna/medium (5,323/96, 5,535/98 and 5,571/73); the latter two each reported 4,608 cached input. Exact replay returned `accepted:false`, retained one group/report and added no conversation attempt. The bot was archived and temporary Worker deleted. Hosted restart remains untested; the native workerd restart evidence above is local.

#### 11 — Activity and recovery

Re-read the approved Paper Activity cross-agent timeline and recovery screens before implementation. Add an owner-scoped read model over existing durable domain facts: per-bot/global recent activity, Needs you / Running filters, stable identities and links to the authoritative approval/recovery surfaces. Preserve plans, model usage and delegation inspectors. No extra scheduler, approval endpoint, editable activity database, or automatic retry-all action.

Bound cross-bot reads to the owner's catalog, report partial failures explicitly and never infer permission from a timeline item. Reading Activity must not retry an external action. Show conversation/tool outcomes, steering, background delivery and actionable memory/backup connection issues. Recovery buttons lead to the existing domain operation. Verify ownership, reconnect/restart, paging, failed reads and mobile navigation. Audit historic foreground delegation outcomes so successful completed tasks do not become cancelled merely because their deadline has passed.

The complete product verification and separate Paper-fidelity goal remain subsequent work.



11 local verification: 421 tests across 62 files, typecheck, lint and production build passed. SQLite projection coverage exercises 85 same-timestamp entries, stable keyset paging across new arrivals, expiring approvals without mutating receipts, retried failures, owner-only fanout and partial failures. A shared five-second deadline stops admitting reads after four stalled RPCs; pending/unattempted bots remain explicitly unavailable. Gateway tests reject foreign bots/conversations and unauthenticated reads. Independent backend/frontend reviews are clear after correcting cross-bot recovery links, scoped plan state, one-shot Memory navigation and the RPC admission deadline.

Activity reads do not start runners or retry actions; existing lazy store initialization and deployment-credential seeding can still write. Saved history includes original requests, steering, thinking and committed tool input/results, distinguished from background report turns. Foreground completed child history remains completed after its deadline (native Pi regression). Responsive fixture checks at 1440×900 and 390×844 cover the timeline, saved result dialog and cross-bot Memory navigation; these are UI fixtures, separate from live gateway proof.

### 12 — Complete product verification

Activity merged in PR #31 as `796f352`, after both exact-head checks passed. Final acceptance uses temporary bots and the existing account credential-refresh owner. It exercises real subscription tools and structured-object follow-up, Cloudflare Dynamic Workers, browser destination restrictions, generated-app persistence, Linux checkpoint restore, independent scheduling and authenticated Activity. No copied production refresh token or API-key fallback. Temporary verification Workers and test bots are cleaned up.

Desktop accessibility audit found that the InputGroup disabled selector dimmed the entire composer whenever its Send button was disabled, reducing contrast on still-enabled controls. Disabled styling now follows the actual input control. The desktop sidebar is a named navigation landmark; Recent activity is a named section. After correction, axe reported zero violations for desktop/mobile chat, mobile sidebar and mobile Activity. Manual Tab/Shift-Tab checks confirmed modal focus trapping and Escape dismissal. Axe leaves Base UI focus guards and the blurred-overlay contrast check for manual inspection; this is not a comprehensive accessibility certification.

Hosted acceptance on the subscription connection:

- A substantial request automatically created a three-step plan, created/read a persistent checklist, published/read a private app and computed `17 × 23 = 391` through Dynamic Workers. Saved evidence completed the plan. An owner edit through the same authenticated operation used by chat UI persisted at revision 2; replay retained revision 2, a stale edit returned 409, and a sibling bot returned 404. A later Luna turn read the updated status and notes. Evidence revalidation reopened only the affected checklist step, without starting a model run.
- Six Sol conversation requests reported 43,946 input / 1,088 output tokens. The two Luna follow-up requests reported 14,697 input (6,656 cached) / 77 output. OptChat performed 22 separate Luna summary attempts: 134,106 input (96,768 cached) / 2,163 output. These are observed aggregate provider counts, not context sizes or API prices. Summary validation/revision retries make memory overhead material even for a small journey; active-run compaction remains a separate mechanism. Its native restart and deliberately small-budget proof remain recorded in slice 02c; no hosted long-run compaction is claimed here.
- Independent Cloudflare probes verified bounded code execution/replay/isolation, Browser Run screenshot capture and destination restrictions, and a generated custom app's durable counter action/replay/sibling isolation.
- A one-shot routine admitted its turn at the scheduled time, over 31 seconds before the first status read, and completed the requested marker. This verifies an independent hosted alarm rather than a browser-driven poll.
- Hosted per-bot/global Activity returned exactly one saved synthetic conversation, its original request and answer, rejected foreign/unknown references, and caused zero additional conversation requests. Replaying the completed turn returned `accepted:false`. The simple Luna reply used 5,871 input / 8 output tokens and created no plan. Initial global reads returned 503 during Worker/DO rollout version skew; a fresh read after rollout passed. The deployed source and direct native RPC were checked.

Terminal acceptance exposed an upstream Sandbox 0.12.10 default-session race: its completion monitor can signal before background output labelers finish. A successful `cat` after checkpoint restore returned empty output. The [pinned source](https://github.com/cloudflare/sandbox-sdk/blob/e4877c7368f8b1620bd4400ff831e28fba152eff/packages/sandbox-container/src/session.ts#L1227) and a deterministic Bash wait-order probe explain the timing defect. Keep the pinned release and use its sessionless execution path, documented through [`enableDefaultSession:false`](https://developers.cloudflare.com/sandbox/sdk/configuration/sandbox-options/#enabledefaultsession). The existing direct-instance adapter supplies the exact installed session token; it does not add self-RPC or replay commands. Interactive PTY sessions remain explicit. Preserve bounded streaming, hard cancellation and container teardown.

Local native workerd plus the matching Linux image passed exact unterminated UTF-8 output across three additional teardown/restore cycles, durable checkpoint restore, replay/conflict/isolation, network denial, output bound, Stop, rollback, timeout and archive revocation. Parser coverage also exercises split UTF-8, stderr, nonzero exit, missing completion, cancellation and failing output admission. Full local suite: 422 tests across 62 files; typecheck, lint and production build passed. Hosted verification of the changed adapter follows its reviewed deployment. Synthetic cloud bots were archived and temporary diagnostic Workers deleted; no production refresh token was copied and no owner conversation was used.


12 deployment acceptance: PR #32 merged as `f364576`; production run `38131680063` passed all checks, Alchemy deployment and hosted authentication probes. A fresh hosted synthetic bot wrote a file, streamed exact unterminated output, checkpointed, tore down its container, restored in a subsequent command and returned the same exact bytes. Both commands succeeded and saved their checkpoint; cleanup completed, the bots were archived and the temporary Worker deleted. This exercises the deployed direct-instance adapter.

The functional build goal is complete. The owner-requested visual fidelity work follows in [UI_FIDELITY.md](UI_FIDELITY.md), using the existing approved Paper file. The app uses the ChatGPT subscription only, with no API-key fallback.


Paper fidelity progress: F1–F3 shipped in PRs #34–#36. F4 consolidates the workbench shell, files and memory presentation while preserving bot-scoped state and recovery access. Exact layout, browser evidence and intentional adaptations are tracked in [UI_FIDELITY.md](UI_FIDELITY.md); working-object fidelity and final mobile acceptance follow.

F5 working-object presentation is locally verified: shared live card/workbench, mobile editing, real concurrent conflict/reapply, history and archive/restore. The final responsive/navigation and hosted delivery pass remains in UI_FIDELITY.md.


Paper fidelity source acceptance: F1–F5 merged in PRs #34–#38; F6 completes the mobile navigation and responsive composition. The full local suite (431 tests, types, lint and build), independent review, accessibility checks and actual recovery/navigation interactions pass. [UI_FIDELITY.md](UI_FIDELITY.md) records each design state, intentional adaptation, evidence and hosted-verification boundary. Final release proceeds through the existing reviewed main/Cloudflare workflow. Subscription-only models remain unchanged.


Paper fidelity goal complete — 2026-10-11: F1–F6 deployed in PRs #34–#39. Final source `4f4fc66` passed production run `38135689129`, including the owner authentication boundary. Fresh hosted mobile access also passed the settled accessibility/overflow check. The full evidence and remaining verification limits are in [UI_FIDELITY.md](UI_FIDELITY.md). The functional product and approved visual-fidelity roadmap are complete; no API-key fallback was added.
