# Communication mailbox lifecycles

**Release status — 25 October 2026:** the refactor is [merged, deployed and verified](xstate-effect-release.md). The checkpoints below retain their original source and test scope; pre-merge delivery status is historical.

B07 gives Communication admission, delivery, native execution, Stop and recovery explicit XState owners through the official Effect integration. It fixes a reproduced ownership race: a held native submission could outlive its 30-second lease while a replacement pump or Stop acted on the same task. Stop now revokes future authority immediately, joins the existing owner, and acknowledges cleanup only after native settlement.

## Ownership and persistence

The [task machine](../src/communication/task.machine.ts) and [outbox machine](../src/communication/outbox.machine.ts) decide durable transitions inside existing SQLite transactions. The [outgoing admission](../src/communication/admission.machine.ts), [incoming admission](../src/communication/incoming.machine.ts), [delivery](../src/communication/delivery.machine.ts), [pump](../src/communication/pump.machine.ts) and [command](../src/communication/command.machine.ts) machines choose local progression. Effect scopes own work, interruption and joined cleanup. The [execution](../src/communication/execution.machine.ts) and [model-request](../src/communication/model-request.machine.ts) machines govern the Pi adapter; Pi retains durable execution and recovery.

One application pump owns live work at a time. A persisted owner cannot be stolen by warm lease expiry, cancellation, a deadline or construction of another mailbox facade. If releasing a joined owner fails in SQLite, the activation retains the exact release receipt and retries that write without repeating submit or abort. Explicit result retry first reconciles only that task's known joined receipt. Stop remains actionable while reconciliation writes fail. Interrupted scopes preserve joined cleanup causes.

The existing atomic boundaries remain:

- Outgoing task and transport outbox.
- Incoming task or cancellation tombstone and receipt.
- Terminal result, result outbox and owner release.
- Conversation continuation admission and consumed result.

Terminal output and its result outbox remain immutable. A later Stop acknowledgement is a separate cleanup fact; unconfirmed cleanup retains native pins. Native identity stays `communication:${task.id}`, with conversation, provider and route pinned. The final provider gate checks current permission again after awaited work. A denied known Communication provider raises `CommunicationError`; only an unknown provider returns `false` for routing to another owner.

## Budgets and discovery

| Operation | Bound and recovery rule |
| --- | --- |
| Native control | Three control failures; ordinary replay cannot renew the budget. |
| Result continuation | Three claimed attempts in the existing task control record. Exhaustion preserves saved output; **Retry result** renews only this continuation under fresh discovery. |
| Native Stop | Five attempts within 300 seconds from receiver admission. Sender timestamps and delayed transport cannot consume that window before acceptance. |
| Transport outbox | Eight attempts per authorized delivery budget, preserving envelope identity, deadline, backoff and jitter; ten-second attempt timeout. Explicit delivery retry extends only its delivery budget. |
| Model requests | Three requests on the pinned native task. |
| Ownership observation | Thirty-second lease; expiry is not permission to steal warm work. |
| Lifecycle failure | Three SDK attempts, 100 ms base delay and 1,000 ms cap; exhaustion retains an actionable fact. |
| Admission discovery | Sixty-second retained lease, checked against the actual clock after database coordinator acquisition. |

The [runner](../src/communication/adapters/lifecycle.ts) retains capability `bot-communication`, pump `bot-communication:pump` and discovery job `bot-communication:recovery`. Lifecycle remains the alarm owner. Fresh admission prearms discovery before commit; an early empty scan retains the lease. An exact duplicate receipt does not rearm. Failed authentication neither arms nor accepts. Expired discovery rejects fresh work, while cancellation still commits revocation when discovery scheduling fails or is interrupted. Prior-cancel tombstones use receiver admission time for cleanup budgets too.

## Restoration and explicit recovery

[Repository initialization](../src/communication/adapters/sqlite.ts) transactionally converts legacy task/outbox JSON to schema/workflow version 1 without changing identities or counters. Native adapter JSON also validates version 1. Invalid or future formats and inconsistent projections fail without resetting storage. Legacy payloadless pump jobs remain supported. There is no additional task journal or independently mutable machine mirror.

Cold owner restoration runs only on actual runner activation, never on repository construction or a warm status read. Observation inspects the original native identity; it cannot configure or submit another execution. Missing native execution or receipt remains uncertainty. Pi recovers its own existing work. The recovery inventory includes every obligation, independently of the capped Activity task list.

Unattributed pump or discovery failures use one Lifecycle-owned key, `bot-communication:failure`. Its [recovery machine](../src/communication/recovery.machine.ts) stores versioned current context `{ schemaVersion: 1, workflowVersion: 1, recovery, retiredEpoch }`. It accepts the earlier summary-only form and rejects future versions. `MailboxView.recovery` exposes the current failed epoch and message. This scheduling fact does not invent a terminal outcome for an unrelated task.

After exhaustion, the failed epoch has no active retry alarm. A failure marker can commit before the SDK removes its running row, so dispatch rechecks current ownership after reading recovery state and rejects both the failed epoch and the retired token. Ordinary wake cannot reschedule that row. The pump captures its causal discovery token when dispatch starts; an older failure cannot cancel a newer admission's lease. Failed marker persistence retains an exact warm receipt for later reconciliation.

**Retry mailbox** sends `{ id: epoch, action: "retry_mailbox" }`. It validates the current summary, prearms a tagged lease, then transactionally clears only the matching summary under that live lease. An alarm before this commit retains discovery but cannot dispatch. Retry retires the matching surviving pump token; a discovery-only failure preserves any previously retired pump. Retirement survives another admission or lease expiry. The next pump gets a fresh epoch, and stale UI retries cannot clear a later failure. Fresh admission may establish its own epoch without renewing another task's budget. Ordinary discovery explicitly clears the precommit recovery tag; retirement is stored separately.

## Verification and provenance

The [evidence manifest](evidence/xstate-effect/b07-evidence-manifest.json) records byte lengths, SHA-256 hashes, original artifact paths and candidate source hashes. Raw logs and JSON are copied unchanged with `.txt` suffixes. The base commit alone does not identify the uncommitted candidate.

The [focused checkpoint](evidence/xstate-effect/b07-focused-unit.log.txt) passed **183 tests in 12 files** before one final test-barrier synchronization edit. The preserved [integrated unit/build log](evidence/xstate-effect/b07-full-unit-build.log.txt) includes that edit and records **2,909 tests in 259 files**, with two workers, plus website, site-routing and all seven Worker builds; [static-5](evidence/xstate-effect/b07-full-static.log.txt) also passed. The combined browser gate passed **92 journeys**, passkeys and two-build recovery, including eight focused Activity recovery cases. These combined gates ran above F15 `0cf6861`, before this tree inherited B09 `8304a30` and before the current B08 family-revocation repair. They do not verify the current composition. B07 independent review closed after five recovery sequences and the actual SQLite continuation-release failure; the latest native recovery-epoch positive/negative proof below covers final B07 core. B07 remains unpublished, with current integration verification open in the [evidence ledger](xstate-effect-evidence.md#active-implementation--b07b08-and-b10b18).

| Native proof | Raw artifacts and scope |
| --- | --- |
| Final recovery epoch: positive | [Log](evidence/xstate-effect/b07-native-epoch-positive.log.txt), [JSON](evidence/xstate-effect/b07-native-epoch-positive.json.txt), [Workerd log](evidence/xstate-effect/b07-native-epoch-positive-workerd.log.txt). Actual Lifecycle exhausts three callbacks, commits a summary while its SDK row still runs, then survives SIGKILL and an autonomous cold alarm without a fourth callback. Explicit retry creates distinct epochs; stale retry fails; a second restart retains failure. The four embedded source hashes match the captured candidate. |
| Final recovery epoch: negative | [Log](evidence/xstate-effect/b07-native-epoch-negative.log.txt), [JSON](evidence/xstate-effect/b07-native-epoch-negative.json.txt), [Workerd log](evidence/xstate-effect/b07-native-epoch-negative-workerd.log.txt). Removing only the dispatch recovery/retirement fence in an isolated bundle produces six callbacks instead of three and fails the intended assertion. |
| Earlier native lifecycle: positive | [Log](evidence/xstate-effect/b07-native-lifecycle-positive.log.txt), [JSON](evidence/xstate-effect/b07-native-lifecycle-positive.json.txt), [Workerd log](evidence/xstate-effect/b07-native-lifecycle-positive-workerd.log.txt). Actual application, SQLite, Lifecycle and Pi cover held submit across 30 seconds, joined held abort, 60-second discovery after lost wake and SIGKILL with no object request, completed native result before lost acknowledgement, exact receipt reuse, one continuation and a second restart. |
| Earlier native lifecycle: negative | [Log](evidence/xstate-effect/b07-native-lifecycle-negative.log.txt), [JSON](evidence/xstate-effect/b07-native-lifecycle-negative.json.txt), [Workerd log](evidence/xstate-effect/b07-native-lifecycle-negative-workerd.log.txt). Disabling discovery retention leaves the outbox pending instead of accepted after restart and fails the intended assertion. |

Run the short final-source proof with Node 24: `node scripts/test-communication-control-runtime.mjs --recovery-only`. The `--negative-exhausted-epoch` variant must fail. The fixture holds production `onJobError` after marker persistence and before SDK outcome application. It shortens only the real row's hung timeout from 600 to one second and rearms through Lifecycle; it does not replace the queue. The cold interval exceeds three seconds without an object request. Errors are synthetic and occur before any domain claim or provider/native task execution in this short scenario.

The earlier lifecycle artifacts have no embedded source hashes and predate the final incoming, continuation and generic recovery repairs. They are retained checkpoint evidence, not exact-final-source coverage for those repairs. The broad native baseline also predates the final generic repair; the latest short native proof covers that repair. Native authority and provider responses are synthetic, so these tests do not establish full PersonalAgent authentication, live provider effects or exactly-once external execution.

Liveness assumes eventual storage availability and alarm delivery within an unexhausted policy. If all writes fail and the activation dies before acknowledging any failure record, the warm receipt cannot survive; no second journal or unbounded retry alarm is claimed. These local results do not establish PR checks, CI, merge or deployment status.

## Final composed publication candidate

The [publication manifest](evidence/xstate-effect/b07-b08-publication-manifest.json) records final source hashes above inherited B09 `8304a30`. [Static checks](evidence/xstate-effect/b07-b08-final-static-7.log.txt), [2,936 tests in 262 files and all builds](evidence/xstate-effect/b07-b08-final-unit-build-2.log.txt), and [all ten native runtime suites](evidence/xstate-effect/b07-b08-final-native.log.txt) passed with the final Communication recovery fence and Coordination family-revocation correction. This full native run supersedes the earlier broad-run limitation above; the historical artifacts retain their original provenance. Generated route output was preserved separately and restored to the exact base file, followed by a passing TypeScript check.

The [browser checkpoint](evidence/xstate-effect/b07-b08-browser-checkpoint.log.txt) passed 92 desktop/mobile cases, passkeys and two-build recovery on the earlier `0cf6861` composition. Frontend sources are unchanged; B09 inheritance and the final Coordination correction changed backend code. Exact-commit hosted CI remains the publication gate. No live provider, merge or deployment result is claimed.
