# Routines and webhook admission (B11)

**Release status — 25 October 2026:** the refactor is [merged, deployed and verified](xstate-effect-release.md). The checkpoints below retain their original source and test scope; pre-merge delivery status is historical.

Routine availability, run admission and recovery, webhook activation and receipt admission, and local command/ingress/pump ordering now have owning `@xstate/effect` machines. Existing SQLite records and receipts remain authoritative. Conversations admits the original turn identity, Pi owns native execution, Access owns tool authority, and Lifecycle remains the physical alarm owner.

## Invariants and preserved behavior

- A saved routine has one revisioned availability record. Pausing, editing or rotating a webhook cancels only unadmitted work. An admitted run retains its original instructions and turn ID and can finish within its ten-minute budget. Manual Run remains allowed while paused. Archived routines cannot admit new work.
- At most one pending, queued, stopping or unconfirmed routine occupies a bot's routine slot. Exhaustion cannot silently release an admitted reply. Only a correlated terminal Conversation result releases its occupancy; explicit Stop changes the control revision and retries the existing obligation.
- Scheduled intervals coalesce using the existing elapsed-minute calculation. Pausing an unadmitted scheduled run restores its scheduled time so resuming can claim it with a new run identity. Webhook receipts and operation receipts remain permanent when run history is pruned.
- Webhook acceptance compares the exact normalized payload hash under `(routine_id, event_id)`. An exact duplicate returns the original run ID, including after key rotation/history pruning. Changed payload reuse fails. Current key authorization is checked before duplicate replay; a revoked key never gains access through an old receipt.
- The shared application/Pi transaction coordinator still atomically commits webhook receipt plus routine run, and routine queued checkpoint plus Conversation admission. A queue checkpoint failure rolls both owners back. Pure machine transitions run synchronously inside that transaction; no actor mailbox, model call, alarm scheduling or awaited cleanup runs inside it.
- The pump refreshes the existing FamilyAdmission authority after awaited model/discovery preparation and before Conversation admission. A pass-start result is not a continuing authority lease. Denial suppresses new admission while retaining known Stop and observation; a lookup failure retains its Cause and cannot admit. Conversation/Pi dispatch keeps its own fresh family check. Family generation fencing also cancels manual pending work from already-paused routines, using the run ID rather than the routine ID.
- Current routine revision and availability are checked again in the admission transaction after asynchronous model/discovery work. A pause, pending Stop or key rotation winning that race prevents later admission. A stale run completion cannot finish a different turn.
- Preparation/acknowledgement actors use explicit Effect scopes. A local pump's semaphore releases only after actor scope cleanup joins. A warm `RoutineRunner` facade shares the actor's dispatch ownership map and cannot reclaim an active pass or reset its retry budget.

## Machines and representation

| Owning module | Lifecycle decisions |
| --- | --- |
| `routines/routine.machine.ts` | Absent, active, paused, archived; create/edit/status, trigger eligibility, schedule advancement and revision-fenced admission. |
| `routines/run.machine.ts` | Pending, queued, stopping, unconfirmed and terminal outcomes; finite pending deadline, execution deadline, explicit Stop, correlated completion and recovery exhaustion. |
| `routines/command.machine.ts` | Receipt lookup, optional discovery arm, atomic mutation and acknowledgement. HTTP and native Pi tools use the same machine. |
| `routines/pump.machine.ts` | Observation, terminal recording, Stop, due claiming, model readiness, discovery, current family authority, admission and scheduling. Cleanup-only mode skips new dispatch while retaining observation/known Stop. |
| `routines/discovery.machine.ts` | The retained Lifecycle discovery lease; an empty scan before the horizon retains a final scan. |
| `webhooks/activation.machine.ts` | Revisioned key enable/disable/rotation. Hash presence reconstructs availability, without a second writable status. |
| `webhooks/admission.machine.ts` | Authorized duplicate, conflicting identity, paused/unavailable, occupied, full and accepted receipt decisions inside the shared transaction. |
| `webhooks/ingress.machine.ts` | Bounded preparation, discovery arm, atomic acceptance and joined acknowledgement. |

The existing routine JSON record carries `schemaVersion: 1` and `workflowVersion: 1`. A run also carries its derived admission deadline and `controlRevision`; SQL status/identity columns are projections written with the record and validated on read. No library actor snapshot is persisted. The explicit legacy decoders retain the original IDs, timestamps, status and native turn ID without replaying a trigger. Partial or future versions fail before new work. Webhook activation rows have the two version columns; immutable webhook event/operation receipts do not have an independent lifecycle and remain unchanged.

Migration `20261023140049_routines_webhooks_lifecycle` preserves existing rows and receipts, adds webhook version columns, expands the run status constraint, and transactionally adds the routine/run version fields only to records with both versions absent. The existing library pins and native Pi task implementation remain unchanged. Unsupported data requires a compatible application revision or a tested conversion; deleting records or changing IDs is not a recovery procedure.

## Discovery, finite budgets and recovery

Fresh active saves/resumes, manual Run and new webhook admission require a discovery deadline that is still in the future when their transaction accepts intent. `RoutineRunner.armDiscovery()` durably arms `routines:discovery` before acceptance and returns a sixty-second lease. A scan starting before the horizon retains a scan at the horizon even when its first result is empty. A subsequent commit therefore does not depend on the post-commit HTTP/Pi acknowledgement wake. The existing `routines:pump` identity is retained, including explicit legacy payload compatibility.

Exact operation replay, pause/archive, paused saves and operation cancellation do not depend on healthy scheduling. The command machine checks the existing receipt first, then validates the same immutable input again in the transaction. A fresh enabling request with unavailable/expired discovery fails before persistence. An acknowledgement failure after commit retains the original receipt and can be replayed without another scheduling call.

Each pending run has a twenty-four-hour admission budget measured from its original creation. Expiry records a failed outcome with instructions to check the model connection/capacity and explicitly run again. This corrects the former indefinitely pending run. Once admitted, the existing ten-minute budget applies. Expiry records `stopping` and requests Conversation Stop while retaining occupancy and the native turn identity.

Lifecycle owns three transport/storage attempts per pump dispatch, with 100 ms base delay and a 1,000 ms cap. A wake during a live/failed dispatch rearms the same budget. Exhaustion is fenced by the current job token, run identity and control revision: pending work becomes failed; admitted work becomes unconfirmed with an actionable inspection/Stop instruction and no automatic routine retry. Explicit Stop uses `requestStopRun`, leaving pending-only cancellation semantics intact for pause/key-rotation callers. It never authorizes another native submission. Conversation/Pi retain their own execution and Stop recovery policies.

An exhausted discovery scan before the lease horizon retains its final scan. A scan exhausted at/after the horizon retires under its bounded policy. If storage cannot even persist an exhaustion outcome, logging and the original domain facts preserve the uncertainty; this is not confirmed recovery. Liveness assumes eventual storage/native availability, an unexhausted relevant recovery policy, and actual Lifecycle alarm delivery. `nextWake` alone cannot wake an evicted object.

## Verification

The focused suites cover original behavior, exact mutation and webhook replay, input mismatch, shared-transaction rollback, expired discovery, pause/Stop/key-rotation races, admitted-instruction retention, full bounded payloads, malformed and future versions, legacy reconstruction, finite admission expiry, recovery revision fencing, unconfirmed occupancy, cleanup-only authority, scheduler outage parity in HTTP/native Pi tools, and cancellation while a native finalizer is held. Runner tests cover retained empty discovery, stale outcomes/exhaustion, legacy/future jobs, three attempts and duplicate/warm-facade dispatch.

On Node 24, the six domain/characterization suites passed 72 tests; the separate command/runner/machine pass passed 18 tests, including four additional command/scope tests (76 distinct tests total). Scoped architecture/Effect lint passes. The meaningful native SIGKILL/no-new-request positive and broken-discovery negative controls are owned by `tests/runtime/routines-worker.ts` and `scripts/test-routines-runtime.mjs`; final-source results are recorded below. A subsequent deterministic authority regression reproduced one stale local admission when membership was removed during prearm; its cached-authority negative control confirms the existing Conversation guard still prevents native submission. The post-prearm authority fix passed 39 focused tests, and the production worker family-fence suite passed 16, including removal/replacement of a membership with a paused manual pending run. Native restart and broken-alarm controls were rerun after the authority change against identical final-source bundles. Unit evidence does not establish exactly-once external provider execution, production deployment or live webhook delivery.

```sh
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm exec vitest run tests/routines.test.ts tests/webhooks.test.ts tests/webhook-ingress.test.ts tests/pi-routines.test.ts tests/routine-runner.test.ts tests/routine-machine.test.ts tests/routine-commands.test.ts tests/routine-family-authority.test.ts tests/family-model-authority.test.ts --maxWorkers=2
```

Pure schedule arithmetic, validation/content normalization, stable native tool-operation identity hashing, HTTP error projection and the immutable event/change receipts remain data computation or protocol adaptation. The previous imperative pump progression, status setters and unbounded sixty-second retry path have been removed.

## Final native evidence (23 October 2026)

The final positive run passed on Node 24.21.0 and workerd 1.20261002.1. An actual alarm first scanned an empty routine store and retained its sixty-second discovery lease. Webhook and manual intents then committed while their post-commit wake was lost. After SIGKILL/restart, no Durable Object request occurred during recovery: the retained physical alarm completed both original runs. Each retained its run ID, Conversation turn ID, webhook receipt where applicable and native Pi receipt, with one admission, one submit and one synthetic model call. Exact replay and payload-conflict checks passed, as did pause before admission, pause after admission, Stop before native submission and a second SIGKILL/restart without changed records or repeated submission.

The `--break-wake` negative control removed the physical alarm while retaining domain intent and Lifecycle job records. It exited with the expected assertion `webhook: alarm must recover without any object request`, observing `pending` instead of `done`. Positive and negative runs bundled the same 73 local source inputs; every captured input hash still matched the worktree after both runs. No fixture or production source repair was needed during this rerun.

- Shared bundle SHA-256: `158126c8f2f1c0eb71ab939903af06f5fe07677df4cc11372652c208d575d2c2`.
- Script SHA-256: `f80f5588ef75b03b73a5668bbf0ee58f039fc6e1d3f949694b3e26ba7af3d93b`.
- Raw final logs: [positive](evidence/xstate-effect/b11-b12-2026-10-23/b11-positive.log.txt) and [broken-wake control](evidence/xstate-effect/b11-b12-2026-10-23/b11-broken-wake.log.txt). Their first lines contain every bundled source hash. Earlier local logs remain preserved with the `-before-authority.log` suffix.
- [Original native evidence](evidence/xstate-effect/b11-b12-2026-10-23/b11-native-evidence.json.txt) records log hashes, expected exit codes and the no-drift check. The [capture manifest](evidence/xstate-effect/b11-b12-2026-10-23/manifest.json) records original paths and verifies the immutable copies; all 73 source hashes still matched at capture.

This proves the composed RoutineRunner/Routines/Webhooks/Conversation/SQLite/native Pi recovery path with a synthetic provider and an always-allow family capability. The deterministic FamilyAdmission and actual worker composition tests above establish the revocation race behavior; this native fixture does not execute the full PersonalAgent authorization boundary or a live provider effect.

```sh
PATH=/opt/homebrew/opt/node@24/bin:$PATH node scripts/test-routines-runtime.mjs
PATH=/opt/homebrew/opt/node@24/bin:$PATH node scripts/test-routines-runtime.mjs --break-wake
# The second command must fail at the missing-alarm pending-versus-done assertion.
```

## Branch verification and provenance

The frozen B11/B12 candidate was checked on `codex/xstate-routines-apps`, based on `0cf6861ab5a89686d3956e0f85f480446c1f9bf8`, with the uncommitted domain changes and schema prerequisites 17–19 (coordination, workspace and routines/webhooks). B07–B10 runtime inheritance was still pending. These results apply to that branch candidate; the later composed stack requires its own exact-tree verification.

| Gate | Recorded result | Raw evidence |
| --- | --- | --- |
| Static | Secret scan, route/migration generation checks, TypeScript, lint and formatting passed. | [Log](evidence/xstate-effect/b11-b12-2026-10-23/final-static.log.txt) |
| Unit and builds | 2,771 tests in 254 files passed; website routing and Worker builds passed. | [Log](evidence/xstate-effect/b11-b12-2026-10-23/final-unit-build.log.txt) |
| Browser | 90 desktop/mobile cases, passkeys and the two-build client upgrade passed. | [Log](evidence/xstate-effect/b11-b12-2026-10-23/final-browser.log.txt) |
| Native | All ten native suite commands passed, including Routines and Apps. | [Log](evidence/xstate-effect/b11-b12-2026-10-23/final-native.log.txt) |

The [six focused recovery UI cases](evidence/xstate-effect/b11-b12-2026-10-23/lifecycle-recovery-ui.log.txt) are included in the 90-case total. They cover stopping/unconfirmed routine occupancy and cancelled/exhausted Apps content retention. The [manifest](evidence/xstate-effect/b11-b12-2026-10-23/manifest.json) separates capture-time source hashes from run-time provenance and records the reported exit codes; artifact capture did not rerun these gates. No live provider, merge or deployment claim follows from these results.

## Final stack composition

This layer now inherits Workspace and the preceding lifecycle layers at `2c5e6f6`. The [publication manifest](evidence/xstate-effect/b11-b12-publication-manifest.json) records final source hashes and differences from the earlier checkpoint. [Combined static checks](evidence/xstate-effect/b11-b12-composed-static.log.txt), [3,045 tests in 272 files](evidence/xstate-effect/b11-b12-composed-unit.log.txt), and [website/routing/all Worker builds](evidence/xstate-effect/b11-b12-composed-build.log.txt) passed. Composition preserves the domain implementations and removes the superseded host runners; required native verification includes all thirteen inherited suites.

The earlier 90-journey/passkey/two-build and ten-suite native results remain scoped to their recorded branch. Full hosted CI on the published commit is still required. No merge, deployment or live-provider outcome is included.
