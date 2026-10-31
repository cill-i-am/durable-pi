# Remaining application and host protocols

Implementation baseline: current main `9d4ec7cf50b88dd68fec029f1c464b5138fc9c52`, 31 October 2026. The earlier checkout at `ad5e8b0` predates the repository-wide migration and is not the implementation baseline.

This follow-up covers the six application/host protocol families identified by the current-source audit. Existing domain machines remain authoritative. Communication's matching post-cleanup receipt backlog is included with Conversations. Transport resource mechanics, parsers and presentation state retain their existing owners; this is not a claim that every temporal variable was replaced.

## Owners and invariants

| Responsibility | Machine and progression | Preserved boundary |
| --- | --- | --- |
| Browser error reporting | `observability/browser-report.machine.ts`: admission selects send/reuse/drop using the five-per-minute window; an admitted request goes sending → settled. | The WeakMap holds native task promises by error identity. Duplicate objects reuse the exact promise after success or failure. SSR sends nothing; reporting failures cannot trigger another report. Effect owns fetch and unread response cleanup. |
| Sandbox iframe actions | Existing `features/apps/web-canvas.machine.ts`: ready → acting → rendering/ready. The child bridge no longer maintains its own writable admission flag. | Native controls still disable immediately on submission. Only trusted DOM events are forwarded; the parent fences origin, source window, channel, current revision, visibility and disabled state. Duplicate messages during acting cannot invoke another action. |
| Checklist store | `features/objects/object-store.machine.ts`: open/unconnected → loading → ready or blocked; open → closing → closed. | Connection is one-time. Unreadable drafts remain untouched and block writes. Close revokes admission synchronously, waits for actor acquisition and joins the Effect scope. Actor maps, native join promises and external-store projections remain resource/data structures. |
| OAuth SDK binding | `access/oauth-binding.machine.ts`: unbound → resolving → bound/unavailable. | Same identity is a no-op; changing it throws. Every guarded SDK storage operation still checks the connection ledger's active revision. SDK credential work, cleanup context and pending generation promise retain their native owners. Existing nonce/PKCE namespaces are unchanged. |
| Joined control releases | `conversations/control-release.machine.ts` and `communication/release.machine.ts`: clear ↔ pending. | Receipts enter only after native cleanup joins. Failed persistence retains the exact owner/result for reconciliation; only its matching acknowledgement removes it. This grants no new attempt or Stop authority. SQL/Pi and durable recovery remain unchanged. |
| Memory controller write acknowledgement | `memory/controller-record.machine.ts`: observing ↔ retained, instantiated with each controller's schema. | Exhaustion is retained before storage IO. Failed writes cannot renew admission. A generation fences reads and acknowledgements begun before a newer retained exhaustion. Backup settlement does not clear warm exhaustion or its claim. |

The synchronous machines use official `setupEffect` definitions and pure XState transitions at native setters, external-store entry points, storage completions and joined finalizers. They do not start asynchronous mailboxes inside database transactions. Admitted report work uses `createEffectActor` in an owned Effect scope.

## Compatibility and intentional behavior changes

No database migration, new durable snapshot, workflow version, provider identity or native task identity is introduced. Existing controller records, browser drafts, receipts and recovery epochs remain valid. Controller schemas still reject future workflow versions without resetting storage.

The memory write fence strengthens the old wrapper: a read or acknowledgement already in flight cannot clear a subsequently retained exhaustion. It fences warm-host authority only; it does not make two storage writes atomic or replace the existing serialized durable owner.

Diagnostic fetch starts through the Effect actor, so event dispatch no longer implies that fetch has started in the same JavaScript stack. Callers already consume a Promise; listener tests observe actual request start. Unread response cleanup is joined before the reporting Promise settles.

## Verification

Focused tests cover:

- Report deduplication, rate-window boundaries, failure retention, cleanup joining and SSR.
- Native OAuth pending binding, repeated assignment, revocation and existing callback/credential behavior.
- Checklist disposal during acquisition, unreadable draft recovery, retained mutations and late native cleanup.
- Held iframe duplicate messages, revoked authority, stale channels/revisions and mounted browser interactions.
- Conversation/Communication release-write failure and exact receipt retry after cleanup.
- Summary/backup failed writes, late reads and acknowledgements, cold reconstruction, unsupported versions and backup claim retention.
- Runtime schema rejection for every new event-bearing machine.

Failure-sensitive control: disabling the controller generation checks makes both late-acknowledgement tests fail by returning `available` instead of retained `exhausted`. The checks were restored before the complete verification run.

| Gate | Local result |
| --- | --- |
| Static | Secret scan including new files, route generation, migration-manifest check, typecheck, Effect diagnostics, compiler-tooling tests, architecture lint and formatting passed. The final controller-validation change also passed refreshed typecheck/lint/format and secret checks. |
| Unit and builds | All 3,992 tests in 343 files passed on the final source. Website build and route checks passed; final Worker bundles built. |
| Native recovery | All 15 `verify:native-runtime` suites passed, including full PersonalAgent, Communication/Conversation held cleanup and release, Summary/Backup recovery, and native XState intent/receipt restoration. Workerd and real local SQLite/alarms are exercised; provider responses and external services remain synthetic. |
| Browser | Desktop/mobile Playwright: 361 passed, 11 intentional skips. All five component-lifecycle fixtures, built-site passkeys and two-build client-upgrade recovery passed. HTTP/provider fixtures are synthetic; these are local browser journeys. |
| Containers | No container or workflow inputs changed; the CI path filter skips these builds for this change. |

These results were recorded locally before publication. Hosted checks and deployment are tracked on the pull request.

## Responsibilities deliberately retained

The audit's infrastructure families remain with Effect or the native API: callback completion and Cause propagation (`shared/interop.ts`), resource drain/join registries, HTTP response ownership, stream readers/locks, backpressure, terminal byte relays, resource transfer, SQLite coordination and incremental parsers. They support existing application machines; none receives a second retry, persistence or execution engine in this change.

Clipboard feedback, nested drag hover, queued-turn scroll anchoring and settings entrance animation remain presentation/native callback state. Upload, conversation, drawer and deferred-navigation authority remains in the existing machines. These exclusions are responsibility-specific, not blanket exclusions for their files.
