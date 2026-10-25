# Access lifecycle migration (B01)

**Release status — 25 October 2026:** the refactor is [merged, deployed and verified](xstate-effect-release.md). The checkpoints below retain their original source and test scope; pre-merge delivery status is historical.

The Access ledger now reconstructs `operation.machine.ts` from its existing rows for every approval, claim, cancellation, revocation, expiry and completion. `run.machine.ts` owns a caller's admission, wait, claim, replay and execution lifetime through the official Effect actor host. This is the first production migration after the standards PR; the repository-wide goal remains open.

## Invariants and representation

- An operation ID retains its exact turn, tool and input. Reusing it with different content fails. A repeated decision can return its saved outcome but cannot restore a subsequently changed grant.
- Approval requires its operation revision; remembered permission also requires the current policy revision. Dispatch checks current run authority and policy again. Recoverable execution requires the original grant revision and an unexpired deadline.
- The claim commits `running` before work starts. Receipt recording is another transaction. A failed receipt write leaves `running`; nonrecoverable re-entry commits `interrupted` and fails with an unknown outcome. It never resends the work. Late completion cannot overwrite an interrupted or completed row.
- Pending and approved operations may be cancelled, revoked or expired. A running operation has already crossed dispatch: cancelling future authority does not claim that its external action stopped. The native execution owner retains that responsibility.
- `tool_operations` and `tool_operation_history` remain authoritative. The adapter writes the machine's result and history in the existing shared application/Pi SQLite transaction. No mailbox runs inside that transaction, no external work runs before commit, and no second snapshot or execution journal is introduced.

Migration `20261023071529_tiny_korvac` adds `schemaVersion=1` and `workflowVersion=1` to existing rows. All eight prior status values are compatible with workflow 1; IDs, grants, decisions, revisions, deadlines, history and results remain unchanged. Reads reject unsupported versions; operators must use a compatible application revision or an explicit tested migration, never reset storage. Pure reconstruction does not execute entry work. Unsupported executable descriptors, including invocations and timers, fail before persistence.

The library implementation remains pinned to XState `6.0.0-alpha.68` / Effect integration `1.0.0-alpha.8`; no library snapshot format is persisted. Pi remains `1.3.0`, with no native task implementation migration. These library/native versions are separate from the two application record versions.

## Work and recovery ownership

The local actor has an explicitly owned Effect scope. Its invocation Effects carry the caller's services. Notifications are captured before the claim so an approval arriving between claim and wait registration is retained. Waits use the Effect clock, bounded to the existing 60-second observation interval and approval deadline. Scope closure joins executing work and cleanup.

The official host joins invocation shutdown but discards its late output. The caller therefore retains execution failure diagnostics and attaches previously unreported non-interruption reasons after joined shutdown. This preserves the existing SDK callback contract: cancellation plus a late tool defect remains `Interrupt` plus `Die`, and never becomes a successful receipt. This observation does not authorize another state transition or retry.

Access authorizes an existing execution; it does not own a new durable dispatch queue. Pi/tool owners retain execution recovery, and existing conversation/channel owners wake waiting work. No independent alarm or retry owner is added. An interrupted local waiter leaves its durable approval available for an explicit/native resume; an approval alone does not promise a newly scheduled execution. Recovery of a native operation is distinct from authorization for a new external action.

`domain.ts` now contains policy presence/configuration validation and result-size validation only. Policy settings are revisioned configuration CRUD, not an autonomous workflow. Receipt and activity projections remain queries. The former `admitOperation`, `approvalRound`, `decideOperation` and `claimOperation` progression and the gate's handwritten wait/dispatch loop are removed. SQL status selection only locates candidate records; the machine decides each change.

## Verification

Characterization covers approval/remembered-grant races, exact-input conflicts, revocation, expiry, cancellation, native Pi approval and receipt replay, notification timing and caller service requirements. New tests cover conversion of every legacy state, future-version rejection, malformed events, unsupported descriptors, restoration of pending/running/completed records, failed checkpoint writes, stale completion and joined cleanup. Actor admission tests now await the committed admission notification instead of assuming synchronous mailbox execution.

The native Drizzle harness runs the production store and scoped actor in workerd, kills the process, then verifies restored pending approval, recoverable dispatch, nonrecoverable uncertainty, revoked authority and a saved receipt. The receipt path records one synthetic external effect before restart and none during replay. This is local native-runtime evidence, not a live-provider delivery claim.

A failure-sensitive mutation temporarily removed the running operation's grant-revision check. `tests/access-domain.test.ts` failed its recoverable-dispatch property as required; the original source was restored before the positive suites. The existing late-defect SDK test also caught and prevented a regression during this migration.

Local verification passed on Node 24:

- `pnpm verify:static`: type checking, architecture lint, formatting, migration manifest and credential scan.
- `pnpm verify:unit-and-build`: 2,161 tests in 213 files, application and Worker bundles, and built route checks.
- `pnpm verify:native-runtime`: all six native suites, including 48 Drizzle cases, 41 generic persisted-state comparisons plus the Access restoration assertions, and XState intent/wake/lost-acknowledgement restart controls.
- `pnpm verify:browser`: 66 desktop/mobile journeys, built passkey checks, and two-build client-upgrade/draft preservation checks.
- The [negative grant-fence control](evidence/xstate-effect/access-grant-negative.log) failed as intended; the restored implementation passes the positive property suite.

Access was published as unsigned commit `0a309bd27a64b6cc97ed75609f1b09579f99012f` on [PR #201](https://github.com/cill-i-am/durable-pi/pull/201). The [Check and deploy workflow 39950948740](https://github.com/cill-i-am/durable-pi/actions/runs/39950948740) completed successfully for that exact commit. Container inputs are unchanged; the workflow applies its existing container-input gate. This delivery result covers Access, not subsequent migration layers. No merge, deployment, real-provider send or completed repository-wide migration is claimed.
