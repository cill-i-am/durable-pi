# Durable Pi — build tracker

Started 2026-10-10. Delivery owner: Codex. Status: **slice 01 and password recovery deployed; slice 02a live conversation events in verification**.

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
| 02 — Live conversation control | Text/thinking/tool events stream with reconnect; steer at tool boundaries or queue a follow-up; stop/retry without duplicate turns; archive preserves delivery order; model/reasoning selection. | In progress: 02a events; 02b steering/settings next |
| 03 — Files and attachments | Upload images, videos and documents privately; validate size/type/path; preview/download/delete safely; reference assets in a turn; vision uses supported image blocks; video uses explicit frame/transcript extraction. | Planned |
| 04 — Reusable skills | Create/edit/attach skills to bots; durable revisions; selected skills enter context; import through the intended Executor source; scoped access and recovery. | Planned |
| 05 — Tools and approvals | Connect Executor/MCP; assign tools per bot; Allow/Ask/Deny enforced server-side; approval persists across reload/restart; background work cannot bypass approval; revoke access. | Planned |
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

Proof in progress (2026-10-11):
- 62 tests passed, including stream deltas/removal, cancellation, bounded buffers, late watcher cleanup, replay-data exclusion, stable disclosure identities and thinking/tool-only terminal states.
- Local workerd SSE authenticated snapshot/reconnect/logout check passed. Existing model tokens remain absent from the local stage.
- Read-only reviews identified and resolved hidden terminal status and disclosure remounting; follow-up review passed. Browser checks confirmed expanded thinking/tool details and failed/cancelled status using a synthetic local transcript. Typecheck, lint and production build passed. CI/deployment pending.
- Mid-run steering, retry controls and model/reasoning selection belong to 02b; they are not yet shipped by this change.
