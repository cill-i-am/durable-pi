# Coordination and child-group lifecycles

This B08 candidate gives addressed delivery, local child dispatch and detached child cleanup explicit owners. It also fixes a reproduced Stop race: native abort could acknowledge before a held addressed submission was admitted. Stop now revokes future admission, joins the existing dispatch owner, and only then acknowledges native cancellation.

## Ownership

The [message machine](../src/coordination/message.machine.ts) decides claim, expiry, accepted/failed/unconfirmed outcomes and restoration inside the existing `agent_messages` transaction. Delivery means recipient acceptance, not an answer. Main-conversation admission and message acknowledgement retain their shared SQLite transaction, current authority checks and exact attempt fence.

The [group machine](../src/delegation/group.machine.ts) and [child dispatch machine](../src/delegation/child-dispatch.machine.ts) keep group closure separate from child cleanup. One per-child owner joins initial submission, steering, addressed messages and Stop through native settlement. Detached groups remain open after an initial answer. `Delegations.deliverMessage` shares this owner and preserves the original message identity and attributed text.

Remote children use the [background task machine](../src/delegation/background-task.machine.ts), [scoped dispatch machine](../src/delegation/background-task-dispatch.machine.ts) and group-lifetime owner. Existing Pi documents, native request IDs, budget counters, route and provenance remain authoritative. B03 parent Stop policy is unchanged.

The [admission machine](../src/coordination/admission.machine.ts) prearms discovery before acceptance and checks the lease inside the acceptance transaction. Effect scopes join cleanup and preserve interruption and defect reasons. The [discovery machine](../src/coordination/discovery.machine.ts) retains an early empty scan; the [runner](../src/coordination/adapters/lifecycle.ts) uses the existing Lifecycle capability and pump identity with three bounded SDK attempts. Stale callbacks and hung replacements cannot steal a live owner or delete newer discovery. Actual activation restores once before dispatch.

Known family revocation is persisted before cleanup begins. The worker awaits `Delegations.revoke(turnId)`, which applies group `REVOKE` and active-child `STOP` atomically through the existing parent/group binding, including detached children whose parent has already completed. It creates no operation identity or retry budget and performs no native or scheduler work. Deadline and known-authority reconciliation share the same transition.

The production pump then performs cleanup with `allowDispatch:false`: it admits no new addressed messages, initial child work, steering or reports, and joins the existing native owner before acknowledging Stop. Unknown authority alone does not imply revocation. Repeated known revocation does not restart stopped children or renew exhausted/unconfirmed cleanup; expiry remains effective without renewed authority.

## Compatibility

[Migration 17](../migrations/agent/20261023130802_coordination_lifecycle/migration.sql) adds schema/workflow version 1, revision, phase and attempt identity to addressed messages. Existing accepted, delivered and failed rows retain their corresponding phase. Local Pi group records explicitly convert legacy JSON without changing IDs or counters. Remote BackgroundDocument version 2 accepts version 1 through explicit conversion and keeps schema 2/workflow 1; old stopped flags do not manufacture native acknowledgement. Future or invalid formats fail without resetting storage.

## Verification

Focused checkpoints passed 50 local delegation tests, 49 remote child tests and 33 addressed-coordination tests. Real SQLite/Pi transaction tests cover immutable input, current authority, lost acknowledgement, exact receipt reuse and cleanup-only recovery.

The [native positive log](evidence/xstate-effect/b08-native-coordination-positive.log.txt) records actual Lifecycle, Durable Object SQLite and PiHarness behavior: a real 60-second discovery lease survives an empty scan, commit with a lost wake, SIGKILL and recovery without another object request. A second restart preserves original receipts and the two synthetic provider calls. Held submission settles before abort acknowledgement and Stop return; Stop-first admits no new request.

The [native owner-bypass control](evidence/xstate-effect/b08-native-coordination-owner-negative.log.txt) fails because it admits a new addressed request after Stop returns. The [addressed barrier control](evidence/xstate-effect/b08-addressed-owner-bypass.log.txt) independently fails when the shared owner is removed. Steering uses the same owner, but its separate bypass schedule did not fail; no independent negative sensitivity is claimed for steering.

The final family-revocation correction passed [35 tests in four files](evidence/xstate-effect/b08-family-revocation-positive.log.txt). Five new actual Node SQLite/Pi tests cover a live detached child after its parent completed, atomic all-child rollback/reopen with original identities, unknown authority, a held native submission joined before Stop, rejected post-Stop addressed delivery, and bounded unconfirmed cleanup. A worker composition barrier proves cleanup starts only after durable revocation commits. The [negative control](evidence/xstate-effect/b08-family-revocation-negative.log.txt) omits only explicit revocation persistence and fails at the expected open/active versus closing/stopping assertion. Independent review reran 20 tests and the original corrected SQLite/Pi counterexample: cleanup aborts once and repeated reconciliation does not abort again. Review is clear. The [manifest](evidence/xstate-effect/b08-family-revocation-evidence.json) preserves the transform, probe, source hashes and proof limits.

Run the native proof with `pnpm test:coordination-runtime`; `node scripts/test-coordination-runtime.mjs --break-owner` is expected to fail. Authority and provider responses are synthetic. The fixture proves the production adapters and scheduler, not full PersonalAgent authentication or remote BackgroundGroup RPC composition; the new family-fence proof is SQLite/Pi plus worker composition unit coverage.

The current candidate above inherited B09 `8304a30` passes [full static checks](evidence/xstate-effect/b07-b08-final-static-7.log.txt), [2,936 tests in 262 files and application/Worker builds](evidence/xstate-effect/b07-b08-final-unit-build-2.log.txt), and [all ten composed native suites](evidence/xstate-effect/b07-b08-final-native.log.txt). The earlier 92-journey/passkey/two-build browser checkpoint was on base `0cf6861`; frontend sources are unchanged, and no new browser run is claimed. Publication and exact-head hosted checks remain open in the [inventory](xstate-effect-inventory.md).
