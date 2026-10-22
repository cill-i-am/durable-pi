# XState Effect standard: implementation evidence

Implementation base: `6ce50c15ee9af99fbe7e0c09f3e064ad0b81e1b1`, freshly fetched from `cill-i-am/durable-pi/main`. Work is isolated on `codex/xstate-effect-standard`. The original working checkout's unrelated changes were retained. Open PRs inspected before edits: #198 (upstream observer) and #163 (local Worker startup/cache isolation); neither implements this standard.

## Provenance and versions

The supplied `durable-pi-review-evidence.zip` was extracted without modifying its original files. Archive SHA-256: `79cc729af8af8bbc6f05d1e4a30b28a668b15d29b1345b680e149d5aa126f56a`. All 12 SHA-256/size entries in its [manifest](evidence/xstate-effect/archive-manifest.txt) verified. Its original review commit is `d29803bc8fd8020cefffb5ce08a02a84a2e4f1df`. Its recorded 382 tests in 34 files are historical results; this change does not relabel that report as a current full-pipeline result.

Separate Git worktrees and separately installed frozen lockfiles were used for historical/current witnesses. New runs use Node `24.21.0`, pnpm `12.14.0`, Effect `4.0.5`, Pi Durable `1.3.0`, Agents `0.28.1`, and workerd `1.20261002.1`. The archive recorded Node `24.19.0` and available pnpm `11.25.0`; the runtime difference is retained in this evidence. No deployed-provider observation is claimed.

The selected exact integration pins are `@xstate/effect@1.0.0-alpha.8` and `xstate@6.0.0-alpha.68`. Published peer metadata accepts Effect `^4.0.0` and XState `^6.0.0-alpha.68`. Available alpha.9 instead requires alpha.70. Installed package types/README and the actual `admitSubmission`, PiHarness submission and Lifecycle implementation were inspected, then compiled and exercised. Package selection is not based on floating tags or indexed documentation alone.

## Historical witnesses, freshly revalidated

The archive's probes were run unchanged from its prescribed adjacent-checkout layout, with the Node 24 executable and each checkout's `tsx` loader:

```sh
node --import ./node_modules/tsx/dist/loader.mjs ../review-notes/distributed-probes.mts
node --import ./node_modules/tsx/dist/loader.mjs ../review-notes/terminal-admission-probe.ts
```

Both commands exited 0 on both SHAs. The distributed script asserts the old undesirable observation. Terminal is observational; its JSON was inspected for actual overlap/duplicate counts, not inferred from exit status. These scripts are historical witness revalidation, not regression tests asserting required corrected behavior. Required corrections are tracked in inventory B02–B04.

| Witness | Historical rerun | Current-base rerun | Classification and required property |
| --- | --- | --- | --- |
| W1 reply checkpoint | One synthetic provider call; `sending`, zero receipt parts, no next wake after another pump; explicit recovery gives `uncertain`. | Same. | **Reproduced.** Add owned/deadlined live sending or durable reconciliation. Preserve uncertainty; do not authorize resend from absent acknowledgement. |
| W2 background Stop | One Stop call despite two reconciliations; cancelled parent, no next wake, future authority false. | Same. | **Reproduced.** Retain stop obligation/acknowledgement or explicit unconfirmed outcome, independently of revocation. Pending handoff/unavailable stub does not establish a live runaway. |
| W3 Terminal admission | Distinct commands overlap at scheduler budgets 128/32; held transaction at 128 dispatches duplicate `first` twice behind one row. | Same. | **Reproduced.** Fresh atomic claimant alone dispatches; attempt-owned occupancy remains until joined cleanup. No deployed Cloudflare incidence established. |

Raw outputs: [historical distributed](evidence/xstate-effect/historical-distributed.log), [current distributed](evidence/xstate-effect/current-distributed.log), [historical Terminal](evidence/xstate-effect/historical-terminal.log), [current Terminal](evidence/xstate-effect/current-terminal.log). Terminal schedules were `MaxOpsBeforeYield` 2048, 512, 128 and 32 with/without a held database transaction, plus duplicate identity at 128. No random seed. Controls at 2048/512 admitted one distinct command. Real Node SQLite and production Terminal code were used with a synthetic executor.

## New conformance and enforcement

`tests/xstate-effect.test.ts` verifies synchronous command extraction, no command on duplicate/stale events, revision/attempt/authority fencing, malformed input, unsupported invocation/timer descriptors, compatible domain-data restoration, incompatible versions, ordinary Effect invocation, controlled deadlines and joined cleanup. Runtime validation is configured on `setupEffect`.

`tests/architecture.test.ts` exercises import aliases, namespaces, re-exports, type-only imports, machine placement, legal core helpers and ordinary functions. `tests/architecture-cli.test.ts` invokes the actual configured Oxlint CLI with positive/negative source fixtures. These prove direct mechanical constraints; they do not prove semantic lifecycle coverage or distributed safety.

`node scripts/test-xstate-runtime.mjs` runs the actual native PiHarness, coordinated application/Pi SQLite and Lifecycle alarm owner. It commits an intent without dispatch and separately loses the local acknowledgement after Pi persists a result, SIGKILLs workerd, starts it again, waits without requesting the object, and verifies completed state and one synthetic model call per operation. Process-local failure-injection barriers prevent alarm dispatch before the first kill, so slow CI cannot accidentally complete either application handoff before the tested crash. Another SIGKILL/restart preserves completion. Repeated application admission is idempotent and conflicting payload reuse is rejected.

`node scripts/test-xstate-runtime.mjs --break-recovery` deliberately omits the pre-armed wake. It exits 1 with `committed: alarm must recover without a user request`, actual `pending` instead of `complete`. [Raw negative control](evidence/xstate-effect/broken-wake.log).

`pnpm exec vitest run tests/xstate-effect.test.ts` was also run after temporarily removing the exact `if (!owns(context, event)) return` fence lines. It exited 1 with two stale/restoration tests failing; the original machine bytes were restored and verified by hash before the passing suite. [Raw broken-fence control](evidence/xstate-effect/broken-fence.log).

An earlier exploratory run killed the lost-ack fixture while inference was still active and observed two synthetic provider calls. This is a material limit: native submission dedupe does not promise one model/provider execution before a checkpoint. The passing lost-ack test waits for native result persistence before killing; it proves that narrower reconciliation window.

## Verification ledger

| Command | Fresh result / scope |
| --- | --- |
| `pnpm prepare` | Exit 0; applied the repository's existing Effect compiler/Oxlint patches after frozen installation with scripts disabled. |
| `pnpm exec vitest run tests/architecture.test.ts tests/architecture-cli.test.ts tests/xstate-effect.test.ts` | Exit 0; 65 tests in 3 files, also included in the complete unit suite. |
| `node scripts/test-xstate-runtime.mjs` | Exit 0; both handoff cases complete, one model call, retained native receipt, two forced restarts. |
| `node scripts/test-xstate-runtime.mjs --break-recovery` | Expected exit 1; verifies wake-loss detection. |
| `pnpm verify:static` | Exit 0; secret scan, routes/migration checks, typecheck, lint and formatting passed. Staged-file scan rerun before publication. |
| `pnpm verify:unit-and-build` | Exit 0; 2,145 tests in 211 files, website route checks and production website/Worker builds passed. |
| `pnpm verify:native-runtime` | Exit 0; existing communication, Drizzle, WhatsApp and memory gates plus the new restart proof passed. Reference rerun passed after adding deterministic pre-crash barriers. |
| `pnpm verify:browser` | Exit 0; 66 desktop/mobile tests, built passkey journeys and two-build stale-client recovery passed. |
| Required remote CI | Pending PR publication. Container inputs/workflow were not changed; existing CI decides whether their builds run. |

No merge, deployment, production reset, live email/WhatsApp send, or production provider exactly-once claim is part of this evidence. The [repository-wide goal](../BUILD.md#xstate-effect-lifecycle-refactor) remains open; all B01–B18 and F01–F15 migration items require their own implementation and proof.
