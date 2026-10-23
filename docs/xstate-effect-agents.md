# Agent availability and family admission (B05)

This B05 candidate is materialized on `codex/xstate-agents`, above Terminal commit `c92d5c3137db304b587ea9bf0962a9b0e3fe2fd8` ([draft PR #204](https://github.com/cill-i-am/durable-pi/pull/204), [required exact-head CI passed](https://github.com/cill-i-am/durable-pi/actions/runs/39953819759)). The [extraction manifest](evidence/xstate-effect/agents-extraction.json) records its provenance: 27 files copied unchanged from the frozen archive, plus the Access worker and migration manifest with only the exact B05 blocks added. All 29 destination hashes and the migration prefix check pass. The candidate now passes static verification, 65 focused tests and the native Drizzle suite. Full-unit/build, the remaining native suites, browser checks and hosted CI remain pending; the historical results below retain their earlier scope.

The catalog profile, bot admission projection, archive publication and synchronization, and family-generation admission now use owning `@xstate/effect` machines. The catalog and admission rows remain authoritative; the family membership record retains its existing Durable Object key. Local request actors and the shared generation actor have separate Effect scopes.

## Preserved contracts

- Creation compares the original JSON input before checking capacity. Replaying an identical request returns its current profile without consuming another slot or changing its ID, slug, revision or receipt. Changed input conflicts. Home cannot be archived. Restoring an archived profile consumes a slot; replaying an active restore does not require one.
- Profile transitions and creation receipts commit in the existing shared application/Pi SQLite transaction. Bot instructions and admission revision/status commit together. Older and equal configuration revisions cannot replace newer authority, and a different owner always conflicts.
- Archive publication precedes remote projection. A failed projection leaves the committed catalog state available for reconciliation. The request scope joins publication and projection even if the caller is interrupted, preserving caller services and failure Causes.
- A delayed archive still projects its revocation revision while respecting a newer restored profile. After terminal acknowledgement, synchronization reads current admission again before choosing browser cleanup or pending-work wakes.
- Each family admission performs a fresh directory lookup. Concurrent lookups are allowed. The shared generation machine increments its local epoch before cleanup or persistence; a result from a previous epoch must be read again. This epoch only fences in-flight reads and is not another durable membership authority.
- Generation changes join durable cleanup before admitting new work. Routine pause/queued-run cancellation, conversation Stop and Access cancellation, completed-session coordination fences, and background Stop intent retain their existing owners and ordering. Native abort/reconciliation stays in the existing `waitUntil` ownership path because it may re-enter admission. Waiting for those remote callbacks inside the generation barrier would create a cycle.
- Failure leaves the previous durable generation in place. A later boundary retries the same cleanup obligations before publishing a new generation. There is no new scheduled retry loop or alarm owner. Liveness still requires a subsequent boundary and eventually available storage/directory/cleanup owners.

## Machines and storage

`profile.machine.ts` owns absent/active/archived profile progression. `configuration.machine.ts` owns unconfigured/active/archived admission and revision acceptance. Both reconstruct from validated rows with synchronous transitions inside existing transactions; executable effects are rejected.

`archive.machine.ts` owns catalog publication followed by remote projection. `synchronization.machine.ts` owns configuration, invalidation, terminal acknowledgement, authority reread and wake selection. These are explicitly scoped per invocation and uninterruptible through joined settlement.

`family-admission.machine.ts` owns one request's read/check/retry/result. `family-generation.machine.ts` belongs to the host's existing Effect runtime and owns ready/fencing/persisting states. A caller leaving cancels only its request; the shared generation change continues. Host disposal joins its invoked cleanup before releasing dependencies. Waiters also observe owner failure or shutdown instead of remaining suspended behind a dead actor.

Migration `20261023074535_amusing_union_jack` adds application schema/workflow version 1 to `agent_catalog` and `bot_admission`, preserving all existing columns and records. The membership key `family-membership-generation` accepts legacy string/null/absent values and writes `{ schemaVersion: 1, workflowVersion: 1, membershipId }` after the machine accepts the transition. Null remains the removed-membership sentinel. No directory membership ID, storage identity, receipt or native Pi task is reset. An unsupported version fails before cleanup or mutation. Recovery requires a compatible application revision or a tested conversion, including before rolling back to a binary that only understands the legacy primitive format.

The stored generation is a checkpoint after existing cleanup transactions, not an atomic transaction across catalog, directory, remote runtimes and cleanup owners. A crash after some fences but before checkpoint publication can repeat cleanup on recovery; existing owners must retain their idempotent Stop/close semantics. No duplicate machine snapshot, generic journal or competing execution engine is introduced. Exact library pins remain XState `6.0.0-alpha.68`, integration `1.0.0-alpha.8`, Effect `4.0.5`, and Pi `1.3.0`; no library snapshot or native task-version migration is involved.

The old `agentCreationReplay`, `agentArchiveChange`, `configurationChange`, imperative synchronization progression, and `familyRevision`/`familyTransition` loop are removed. Pure capacity validation, slug allocation, query projections and terminal acknowledgement caching remain in their respective roles.

## Extracted candidate status — 23 October 2026

Preflight confirmed the expected branch/parent and all affected baseline files before applying the patch. The 29 materialized files match their extraction hashes; `node scripts/generate-agent-migration-manifest.mjs --check` passes with only `amusing_union_jack` added after Access. No B02/B03/B06 code, RPC observation changes or later migration is included. The inherited Terminal implementation, evidence and extraction manifest remain unchanged.

| Check | Candidate result |
| --- | --- |
| `pnpm verify:static` | Passed: credential scan, route generation, migration manifest, TypeScript, architecture/Effect lint and formatting. [Output](evidence/xstate-effect/agents-candidate-static.log). |
| Focused agent/family and Access migration tests | **65 tests in 10 files passed**, 4.63 seconds, default timeouts and two workers. [Output](evidence/xstate-effect/agents-candidate-focused.log). |
| `node scripts/test-drizzle-runtime.mjs` | Passed **49 transaction/interoperability cases and 41 persisted-state checks after SIGKILL/restart**. Agent profiles, raw creation replay, admission revision and membership generation survived without repeating cleanup; Access receipt/recovery/revocation assertions also passed. [Output](evidence/xstate-effect/agents-candidate-native.log). |

The focused command was:

```sh
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm exec vitest run src/agents/{catalog,configuration}.test.ts tests/{agent-boundary,agent-machine,configuration-boundary,family-admission-machine,family-model-authority,family-access,family-model-access-parity,access-machine}.test.ts --maxWorkers=2
```

No source correction was needed during these checks. Full-unit/build, the remaining native suites, browser checks, publication and hosted CI remain pending. The required exact-head workflow must establish the complete contract; neither the scoped candidate checks nor frozen combined-tree results replace it.

## Historical verification

Existing tests preserve home/capacity policy, raw creation identity, transaction rollback, owner checks, archive/restore ordering, stale configuration, terminal acknowledgement, caller Context and interruption behavior. New tests cover legacy conversion, incompatible versions, malformed events, restored state, failed membership checkpoints, caller cancellation without cancelling shared cleanup, host cleanup ordering and compound failure Causes.

The held-lookup tests cover both an uninitialized host and an existing membership: a newer admission can complete while an old directory response is held, and releasing that response cannot fence newly admitted work. The native Drizzle probe exercises production profile/admission machines and family admission in workerd, then kills and restarts the process to compare records and verify that the completed membership fence is not repeated.

Before this extraction, the initial isolated migration verification passed on Node 24:

- Static checks: type checking, architecture lint, migration manifest, formatting and the credential scan.
- Full unit/build suite: 2,176 tests in 215 files, application/Worker bundles and built route checks.
- All six native suites: production PersonalAgent/coordination/cleanup, 49 Drizzle cases and 41 generic persisted-state comparisons plus Access and Agent restart assertions, WhatsApp, Memory, upstream observer and XState recovery controls. The first new Agent assertion incorrectly assumed creation-date ordering; it was corrected to compare by ID, and the Drizzle and remaining suites passed.
- Browser gate: 66 desktop/mobile journeys, built passkey checks, and two-build client-upgrade/draft preservation checks.
- The [negative epoch control](evidence/xstate-effect/family-epoch-negative.log) removed the observation fence temporarily. Both delayed-lookup cases then cancelled newly admitted work and failed, as required. Source was restored and all 57 focused agent/family tests passed.

Container inputs are unchanged. Unsigned commits are authorized, but this candidate has not been committed or published. The repository-wide goal remains open. No merge, deployment or live-provider action is claimed.

The frozen B01–B05 tree also passed static checks, 2,483 tests in 234 files, builds, seven native suites, browser and container gates. Its logs remain in `/private/tmp/durable-pi-lifecycles-verified-bcsyeo0t/verification/`. Those historical combined-tree results do not establish this candidate's gates.
