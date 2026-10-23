# Terminal lifecycle migration (B04)

This B04 candidate restores the frozen Terminal implementation on `codex/xstate-terminal`, above Access commit `0a309bd27a64b6cc97ed75609f1b09579f99012f`. Its 14 source files and 10 tests match the archived implementation hashes. The extracted candidate passed static verification and 169 focused tests; full-unit/build/native/browser and hosted CI gates remain pending. The prior combined-tree evidence below demonstrates the W3 correction and Terminal-owned command, resource, lease and observation progression through the pinned official `@xstate/effect` integration; it is not relabeled as an extracted-head result. No production incident or deployed container verification is claimed.

The [extraction manifest](evidence/xstate-effect/terminal-extraction.json) records source/test/log hashes and archive provenance. The existing standards and Access commits provide the shared baseline. Other lifecycle migrations from the combined tree are outside this candidate, and the [repository-wide goal](../BUILD.md#xstate-effect-lifecycle-refactor) remains open.

## Ownership and behavior

| Lifecycle | Authoritative owner | Effect/native responsibility |
| --- | --- | --- |
| Command outcome | `command.machine.ts`, reconstructed from the versioned `terminal_runs.record` | Persist the accepted input before dispatch; correlate progress and results with the original attempt. |
| Occupancy and cleanup | `occupancy.machine.ts`, stored independently of command outcome in that same record | Join runtime, backup, export, connection and actor-scope cleanup before the owning attempt releases the slot. |
| Execution stages | Scoped `execution.machine.ts` actor | Close previous runtime, restore saved workspace, run the selected command/session/transfer, checkpoint or export, then return the correlated result. |
| Command/Save deadline | Scoped `deadline.machine.ts` actor | Effect Clock sleeps; the machine extends startup to the interactive maximum or shortens Save to ten seconds. An expired deadline cannot revive. |
| Interactive lease and connection | Scoped `session.machine.ts` actor | Native PTY handshake/relay work and joined cleanup. READY publishes its runtime capability atomically; only the matching connection generation releases its reservation. |
| Remote command observation | Scoped `client.machine.ts` actor | Native admission/read/state/Stop requests, 500 ms polling and a 45-second observation decision window. Required cancellation acknowledgement and cleanup remain joined beyond that decision window. |

The production `Terminal.start` consumes `{ run, fresh }` from one SQLite transaction. That transaction compares immutable identity/content, rejects occupied or unconfirmed work, checks current authority/history capacity and persists the run plus attempt ownership. Only its fresh claimant dispatches. Replay returns the retained receipt and never authorizes another external command. The old pre-read-as-claim behavior, `admit` convenience wrapper and handwritten admission/outcome reducers are removed.

A semaphore protects local admission/recovery/shutdown resource installation; it does not replace the shared SQLite/Pi coordinator or decide durable command admission. Shutdown marks the host closed immediately, joins any in-flight admission, and cancels an accepted but undispatched intent. Finalizers compare ownership instead of unconditionally clearing a newer active task.

Current attempt ownership, current authority and the durable Stop fence are checked again before consequential execution. The final outcome/checkpoint/export transaction checks attempt identity, authority and cancellation together. A successful result cannot publish through an already-committed Stop even when the earlier cancellation outcome write failed. Stop and archive operations carry their committed facts directly into native abort finalization; another fallible database read is not required to signal cancellation.

Command outcome and resource release are separate. A completed command retains occupancy while close or a late handshake is outstanding. Every independent cleanup is attempted and joined even if another cleanup defects; full Causes survive. Failed close retains blocked occupancy. If resources settle but the outcome could not persist, the original running row plus released-resource fact remains unconfirmed: state exposes recovery, and admission stays blocked. Explicit recovery or host startup records interruption and closes the old runtime without redispatching its command. There is no automatic external-command retry or new alarm owner.

## Compatibility and retained data

The existing JSON row gains `schemaVersion: 1`, `workflowVersion: 1`, `revision`, `attemptId` and `occupancy: { state, ownerId }`. Existing tables and storage identities remain unchanged, so no generated SQL migration is needed. There is no independently writable machine snapshot.

Storage `get`/`claim` retain `CommandRecord`; public start/replay/get/cancel receipts and committed finish/recovery notifications project the `CommandRun` contract. State returns explicit public summaries. The first combined native run exposed an internal ownership-field leak in raw HTTP responses that RPC decoding had hidden; this was corrected at the service boundary, leaving the native equality assertion unchanged. A real-SQLite HTTP test recreates the Terminal/store over retained records and compares completed read/replay receipts exactly. Missing-row Stop returns JSON `null`, matching the client acknowledgement schema; the strengthened Stop-before-admission test failed on a hidden decoding defect before this correction. Its exact post-fix rerun passed (one test, 36 skipped), recorded in `/private/tmp/terminal-cancel-null-after.log`.

Legacy rows without either version field hydrate deterministically. A legacy running row gets attempt/owner `legacy:<command-id>` and retains occupied uncertainty. Completed legacy rows are free. The next state/occupancy mutation writes the converted data inside the existing transaction. Command IDs, immutable input, creation time, output, authority revision, network policy, transfers, checkpoints and exports are retained. Unknown versions and malformed data fail explicitly rather than resetting storage. Restoration reconstructs pure machine state; it does not invoke execution.

The following remain ordinary facts or native resource mechanics under the canonical exclusions:

- `Domain.networkChange` performs optimistic validation and computes ordinary network-policy CRUD. Policy has no pending execution/retry/recovery lifecycle. Its gate projects command/occupancy state inside the same SQLite transaction; each execution retains its admitted policy.
- `terminal_authority` is the monotonic local projection of catalog authority and its revocation watermark. It is not a second bot lifecycle. Reordered revocations/restores remain fenced; the command machine owns resulting outcomes and committed revocation signals native abort.
- `adapters/service.ts` retains native fetch/body budgeting, cancellation signalling and late-promise joining. Application admission, polling, observation deadlines and Stop progression moved into `client.machine.ts`.
- Output buffering/periodic flush, transfer validation and backup byte mechanics remain Effect work or pure computation. They do not independently authorize a command transition.

## Extracted candidate verification — 23 October 2026

The candidate was installed from its frozen lockfile with `pnpm install --offline --frozen-lockfile --ignore-scripts`, then prepared with the repository's `pnpm prepare` command. Dependencies reside in this worktree; no source modules or dependency directories were linked from another checkout. The 24 production/test files and four historical Terminal logs still match the extraction hashes after verification.

| Check | Candidate result |
| --- | --- |
| `pnpm prepare` | Passed; installed Effect compiler and Oxlint patches. [Output](evidence/xstate-effect/terminal-candidate-prepare.log). |
| `pnpm verify:static` | Passed; credential scan, route generation, migration manifest, typecheck, lint and repository formatting. [Output](evidence/xstate-effect/terminal-candidate-static.log). |
| `pnpm exec vitest run tests/terminal*.test.ts tests/native-terminal-addon.test.ts --maxWorkers=1` | Passed **169 tests in 16 files**, 9.18 seconds, repository default timeouts. [Output](evidence/xstate-effect/terminal-candidate-focused.log). |

The checked source/test tree is unchanged from extraction. Evidence-only updates after these runs were formatted and checked for whitespace. Full-unit/build/native/browser and required hosted CI gates have not run on this candidate here; the publication workflow must establish those results on the eventual exact head. No commit, push, merge or deployment is part of this local verification.

## Historical combined-tree verification and remaining gates

`tests/terminal-claim.test.ts` drives the production store/service with real Node SQLite at scheduler budgets 128 and 32, both with and without a held transaction. It checks one duplicate dispatch behind one row, bounded distinct-command occupancy, held final close, stale cleanup ownership, interrupted legacy restoration, current authority after a held restore, compound failure preservation, shutdown during held admission, and Stop/archive write/read failures. The recovery fixture also proves unconfirmed outcomes block another command.

`tests/terminal-coordination.test.ts` proves the actor Clock owns expiry and all independent cleanup defects are retained. Session and deadline TestClock tests cover renewal, fixed lifetime, Save, stale release, delayed READY capability publication, deadline cancellation and scope disposal. The existing authority, ingress, transfer, migration, resource, socket and client suites remain part of the Terminal gate.

Failure-sensitive controls removed the atomic fresh-claim distinction, session release generation fence, and late client Cause retention. The fresh-claim control failed all four held/unheld schedules at scheduler budgets 128 and 32 (two executions instead of one); the session and client controls failed their stale-release and retained-defect assertions respectively. Each source was restored byte-for-byte before subsequent verification. Preserved outputs: [fresh claimant](evidence/xstate-effect/terminal-fresh-claim-negative.log), [session release fence](evidence/xstate-effect/terminal-session-fence-negative.log), and [client Cause retention](evidence/xstate-effect/terminal-client-cause-negative.log).

Historical final scoped suite command:

```sh
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm exec vitest run tests/terminal*.test.ts tests/native-terminal-addon.test.ts --maxWorkers=1
```

The final scoped run after the public receipt correction passed **169 tests in 16 files** in 10.44 seconds with the repository default test timeouts and one worker; [terminal-focused.log](evidence/xstate-effect/terminal-focused.log) is the preserved output. The earlier 167-test run used a 20-second runner override during host contention; product deadlines and TestClock assertions were unchanged. Scoped oxlint, formatting and diff-whitespace checks passed. The initial integration typecheck found two Activity predicate errors; both were corrected and the final whole-tree static gate passed. `/private/tmp/terminal-cancel-null-before.log` records the meaningful pre-fix cancellation assertion failure.

The combined implementation tree also passed static/unit/build checks and the unchanged native Terminal HTTP/PTY/receipt/restart assertions before this extraction. Those runs included other migration layers and do not verify this candidate head. The preserved focused/negative logs above support only their named historical scopes; temporary paths record additional historical diagnostic runs and are not portable evidence artifacts.

The candidate checks recorded above supersede the extraction-time absence of local static/focused results. They do not replace the remaining full-unit, build, native-runtime, browser or required hosted checks.

No live provider send, real container action, merge or deployment was performed by this lane. Frontend lease/socket lifecycles remain separately tracked in F04; Terminal migration/transport host lifecycles outside this B04 boundary retain their own inventory entries.
