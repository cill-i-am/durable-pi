# XState Effect application lifecycles

Decision: required architecture. Implementation baseline: `6ce50c15ee9af99fbe7e0c09f3e064ad0b81e1b1`. This standards change establishes executable conformance references and enforcement. The [repository-wide migration goal](../../BUILD.md#xstate-effect-lifecycle-refactor) remains open until its [inventory](../xstate-effect-inventory.md) is implemented.

## Ownership and applicability

XState owns application lifecycle states, events, guards and transitions through the official `@xstate/effect` integration. Effect owns effectful work, dependencies, interruption and live resource lifetimes. Pure TypeScript functions remain appropriate for calculations, validation and projections. Pi owns durable agent/task execution and recovery. Existing domain storage and Lifecycle retain persistence and durable wakeup responsibilities. Access retains authorization.

Use this separation whenever the application owns state over time and permitted behavior depends on it: event-dependent progression, async completion, cancellation, retries, approvals, resource acquisition/cleanup, recovery or concurrent coordination. This includes a simple upload and a durable agent workflow. A local upload does not acquire Pi merely to satisfy the standard.

Existing and future lifecycles are in scope. Complexity, existing correctness, and file size are not exemption criteria. A `status` field is only a discovery clue: ordinary CRUD, independent UI values, counters, pure transformations, derived views, query caches and external SDK internals are not automatically application lifecycles. Record path-specific exclusions in the inventory.

Place each machine in its owning domain/feature, in a `*.machine.ts` module. Separate independent dimensions: command outcome, resource occupancy and remote cleanup acknowledgement are not one state. Selectors and indexes may project machine state; they cannot independently decide transitions. Remove superseded reducers, setters and distributed control branches when migrating. Neither a mirror of legacy booleans nor a single `running` state surrounding the old imperative lifecycle satisfies this decision.

| Decision | Sole owner and contract |
| --- | --- |
| Permitted next business step | Owning XState machine; pure functions may compute guard inputs. |
| Live work and finalization | Effect invocation/scope; the host joins cleanup before releasing ownership. |
| Native task progress/checkpoints | Pi and its installed implementation; application code does not reproduce its scheduler. |
| Application acceptance and recovery facts | Owning domain ledger, its transaction, schema and event/attempt identities. |
| Future authority | Access/current run and membership authority, checked again at consequential dispatch. |
| Wake delivery | Existing Lifecycle jobs and the one physical alarm owner. |
| Retry | Machine authorizes a business retry; Effect may retry bounded transport work within that attempt; Pi resumes that same native execution. Each operation names its one retry owner and budget. |

An explicitly authorized new attempt has a new identity. Rejoining the same native submission is recovery, not authorization for another external send. Record finite transport retry limits and deadlines. On exhaustion retain an actionable failed/unconfirmed fact; never erase a remote Stop obligation just because future authority was revoked.

## Local execution

Use `setupEffect`, `createEffectLogic` and `createEffectActor` with an explicit Effect scope. Supply services outside the actor scope so finalizers can still use them. A component, request or shared application runtime must own that scope and dispose it. `send` enqueues asynchronously; observe completion with `waitFor`, `join` or snapshots. Do not assume the next statement sees the event.

The [preparation reference](../../tests/lifecycle/preparation.machine.ts) models idle, preparing, ready, failed, expired and cancelled states. Invoked Effect work owns its resources; the machine chooses completion, cancellation and deadline transitions. [Conformance tests](../../tests/xstate-effect.test.ts) drive Effect's test clock and hold an uninterruptible cleanup barrier while closing the scope. Scope closure does not finish until the child cleanup is joined.

Interruption only describes local work. It neither rolls back a provider action nor confirms remote cancellation. Keep resource occupancy until the owning attempt's joined cleanup finishes. Ignore/fence late results from prior attempts. Do not tie a Pi task's lifetime to a UI observer, HTTP request, or local actor.

## Durable execution and persistence

Choose one authoritative representation per lifecycle: a versioned machine snapshot, **or** versioned domain data reconstructing machine state without repeating external work. Never persist independently mutable SQL status and machine snapshots. Projections must be updated in the same commit or derived on read. Preserve existing tables, receipts and outboxes instead of adding another execution journal.

`Sqlite.transaction` and the shared application/Pi coordinator remain mandatory. Native Durable Object SQL callbacks must finish synchronously. Pure `initialTransition`, `transition`, `resolveState` and descriptor inspection are valid here. `createEffectActor`, asynchronous mailbox processing, Pi operations, provider calls, sleeps and awaited cleanup are not. A serialized mailbox is not database atomicity across owners. See [persistence](../persistence.md).

The acceptance commit must validate identity/content reuse, expected revision, attempt and current authority; deduplicate the event; calculate the machine's next state; and persist state plus command intent atomically. Dispatch after commit. Native results become correlated, fenced machine events in another application transaction. A cross-owner handoff is never described as one atomic transaction.

The [submission reference](../../tests/lifecycle/submission.machine.ts) persists domain `value` and context. Reconstruction uses the official Effect-backed machine's synchronous `resolveState`; it does not run entry actions. Its native [host fixture](../../tests/runtime/xstate-worker.ts) keeps this data, immutable command, accepted event identities and native receipt together in one fixture row. This is an executable seam, not a reusable production workflow adapter or a migration of Conversations.

Its `pi.submit` command maps to `harness.session(session).submit(content, { operationId })`. The installed `agents@0.28.1` maps this to `Conversation.submit({ type: "input", requestId, content, whenBusy })`. In `pi-durable@1.3.0`, `admitSubmission` atomically returns an existing submission for the same conversation/request ID and type. It does **not** compare repeated same-type payloads. The host must compare the immutable application content before submission. Native `submissionByRequest` recovers the receipt; the native completed result admits `COMPLETED` with the original attempt, authority generation and expected application revision.

The reference has one attempt and no application business retry. Pending-native observation uses a 100 ms wake with a persisted ten-second application deadline. The machine admits an unconfirmed outcome on expiry, native unanswered outcome or dispatch failure; it retains command/receipt facts and never authorizes a resend. If persisting that outcome also fails, Lifecycle owns three storage/job attempts with 100 ms base delay and 1,000 ms cap. Pi owns native execution and recovery; the synthetic model disables model retries. An unconfirmed application outcome does not cancel Pi. Each production migration must prove its own outage and exhausted-recovery policy; this bounded fixture is not a general adapter.

### Crash windows in the reference

| Window | Persisted facts; owner and next event | Safe repetition |
| --- | --- | --- |
| Before application intent commit | Lifecycle recovery wake is pre-armed; an empty scan retains discovery. No accepted command yet. Caller can repeat `SUBMIT`. | Yes, subject to identity/content comparison. |
| After commit, before dispatch | Domain state is `pending`, command and accepted event exist. Lifecycle dispatches the same native request identity. | Same native submission identity, never a new attempt. |
| Pi/provider acceptance before local acknowledgement | Pi may own a queued/running/completed submission while the application receipt is absent. Reconcile through native request lookup/reuse. | Submission reuse is safe. A model/provider operation interrupted before its checkpoint may repeat; external side effects require their own receipts/idempotency or uncertainty. |
| Result received before application persistence | Pi's result is durable; application remains pending. Lifecycle reads it and re-admits the fenced result. | Yes for native result reconciliation, not a new provider action. |
| Application result persisted before sender acknowledgement | Completed state, revision and event identity are durable. Duplicate events/requests return the existing state. | Yes; conflicting identity reuse fails. |
| State commit before wake scheduling | Recovery was armed **before** admission. No post-commit-only wake dependency. Lifecycle owns the alarm and re-arms jobs. | The pre-armed discovery job may run unnecessarily; it must not disappear on an empty scan. |

The real [SIGKILL/restart test](../../scripts/test-xstate-runtime.mjs) checks both intent-before-dispatch and completed-native-result-before-local-acknowledgement, waits without making a new object request, then checks persisted state, native receipt and provider-call count. A second restart verifies completed retention. The broken-wake control must fail. A prior experiment killed during inference and observed another synthetic model call; no exactly-once external-execution claim follows from native submission deduplication.

Liveness assumes eventual storage/native execution availability, unexhausted recovery policy, and functioning alarm delivery. `nextWakeAt` alone cannot wake an evicted object. Use pre-armed Lifecycle discovery or prove another durable discovery path. Do not add an independent `setAlarm` owner.

### Supported semantics

| Semantic | Local official host | This narrow durable reference |
| --- | --- | --- |
| Effect work/actions | Official scoped Effect host | Only validated `pi.submit` emitted command data; executable action descriptors fail before commit. |
| Invoke/children | Official Effect actors and their scopes | Unsupported; spawn/invoke/child descriptors fail. Production mappings require separate native-owner proof. |
| Timers | Effect Clock/TestClock | Local timer descriptors fail. Deadlines must be machine events delivered by Lifecycle. |
| Event delivery | Actor mailbox; async observation | Accepted identities and state commit in the domain transaction; stale revision/attempt/generation do not advance. |
| Completion | Invocation result/final output | Correlated Pi result admits the final machine transition; root termination is persisted. |
| Cancellation | Scope/child interruption and joined cleanup | No cancellation event is implemented by this reference. A migration must model authority revocation, native/provider stop acknowledgement and cleanup obligations explicitly. |
| Restoration | Official snapshot restore may restart unfinished Effects | Validated domain reconstruction, no entry work; Pi reconciles its own durable execution. |

`commandsFrom` rejects all other descriptors, including invalid-event dead letters. Do not extend this by silently dropping unknown semantics. Local machines do not inherit the durable reference's restricted subset.

## Versions and data compatibility

Exact package pins are `effect@4.0.5`, `@xstate/effect@1.0.0-alpha.8`, `xstate@6.0.0-alpha.68`, `@earendil-works/pi-durable@1.3.0`, and the existing patched `agents@0.28.1`. The registry also published Effect integration alpha.9 requiring XState alpha.70; this change selects the archived compatible pair to minimize the experimental surface and verifies it locally. Floating alpha tags are not permitted. The lockfile is part of the contract.

Installed README/types/implementations settle the API. Matching upstream sources: [Effect actor semantics](https://github.com/statelyai/xstate/blob/%40xstate/effect%401.0.0-alpha.8/packages/xstate-effect/docs/actors.md), [official integration](https://stately.ai/docs/xstate/v6/effect/quick-start), [durable host model](https://stately.ai/docs/xstate/v6/durable-execution). Runtime validation belongs on `setupEffect({ validator: standardSchemaValidator(), schemas })`; the archived configuration placing a validator on `createMachine` type-checked without enforcing the event check. Malformed-event tests are required.

Track four distinct versions: library/snapshot format, application schema, business workflow definition, and native Pi task implementation. The reference stores each separately and rejects unknown versions or invalid states. Tests restore compatible JSON and reject future versions. Production migrations must convert existing records/snapshots transactionally or retain an explicit incompatible-data failure with recovery instructions. Never delete snapshots, reset storage, or change resource identities to avoid a migration. Restoring an unfinished Effect can restart it; receipts and external uncertainty survive.

## Enforcement and review

`architecture/effect-machines` runs for application TypeScript/TSX. It rejects standalone core actor/machine factories, React hooks that start their own actor, their direct re-exports/dynamic imports, namespace calls and imported aliases. It requires `setupEffect` definitions in `*.machine.ts`. Core types, pure transitions and `useSelector` remain allowed. `architecture/boundaries` also applies to every machine module: no concrete feature storage/host/network platform adapters or Effect runners. Both relative paths and `@/` aliases and direct re-exports are checked.

This is direct AST/import enforcement, not whole-program dataflow analysis. Arbitrary wrapper factories, transitive barrel laundering, semantic authority, crash consistency, external idempotency and complete lifecycle discovery still require review, inventory and behavioral tests. No regex claims to find every state machine. Plain functions/projections are valid fixtures. The actual Oxlint CLI is tested with valid/invalid modules in addition to RuleTester cases.

Each migration writes its invariants first, checks caller/write paths, compares behavior except for documented defect corrections, tests deterministic races, stale events, recovery and compatible/incompatible restoration, and demonstrates at least one meaningful failure-sensitive control. Use the existing Vitest, Effect clocks/barriers, real SQLite and native workerd gates; add browser journeys for affected frontend behavior. See [evidence](../xstate-effect-evidence.md).

Earlier historical review advice treating handwritten reducers as an alternative default is superseded. This standard does not close the repository-wide goal, authorize deployment, or provide evidence of live-provider delivery.
