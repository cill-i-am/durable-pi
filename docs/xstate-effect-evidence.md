# XState Effect standard and migration evidence

Implementation base: `6ce50c15ee9af99fbe7e0c09f3e064ad0b81e1b1`, freshly fetched from `cill-i-am/durable-pi/main`. Work is isolated on `codex/xstate-effect-standard`. The original working checkout's unrelated changes were retained. Before publication the branch was rebased onto `696aca98000a6e82a9cb202acc18f92f2c8e987e` after #198 merged; both upstream and XState native gates were retained. The refreshed open-PR check found #199 (idle observer cleanup) and #163, with no equivalent standards PR. Open PRs inspected before edits: #198 (upstream observer) and #163 (local Worker startup/cache isolation); neither implements this standard.

## Current review stack — 23 October 2026

B01 Access is implemented at `0a309bd27a64b6cc97ed75609f1b09579f99012f`. [PR #201](https://github.com/cill-i-am/durable-pi/pull/201) has a completed, successful [Check and deploy run 39950948740](https://github.com/cill-i-am/durable-pi/actions/runs/39950948740) for that exact commit. This is Access CI evidence, not a result for the Terminal candidate or the repository-wide migration.

B04 Terminal is published as unsigned commit `c92d5c3137db304b587ea9bf0962a9b0e3fe2fd8` in [draft PR #204](https://github.com/cill-i-am/durable-pi/pull/204), stacked above Access. All required jobs and aggregate `check` passed for that exact head in [CI run 39953819759](https://github.com/cill-i-am/durable-pi/actions/runs/39953819759); B04 delivery is complete. The draft remains unmerged and no deployment is claimed. Its 14 source files and 10 tests match the frozen implementation archive byte-for-byte; [the extraction manifest](evidence/xstate-effect/terminal-extraction.json) records their SHA-256 values and archive provenance. The four preserved Terminal focused/negative-control logs also match the archive. [Terminal evidence](xstate-effect-terminal.md) records the implemented boundary, retained legacy data, historical combined-tree checks and remaining extracted-head verification. After frozen offline installation and Effect preparation, this candidate passed `pnpm verify:static` and the 169-test Terminal suite in 16 files with default timeouts and one worker. Preserved outputs: [preparation](evidence/xstate-effect/terminal-candidate-prepare.log), [static](evidence/xstate-effect/terminal-candidate-static.log), [focused tests](evidence/xstate-effect/terminal-candidate-focused.log). Those scoped local checks remain distinct from the required exact-head hosted gates, which passed in the workflow linked above.

B05 Agent availability is now materialized on `codex/xstate-agents` above the Terminal commit. The [extraction manifest](evidence/xstate-effect/agents-extraction.json) records 27 unchanged archived files and the two composed shared files: only family imports/layer/fence/admission in the worker, and the `amusing_union_jack` migration prefix in the manifest. All 29 destination hashes match, and the manifest check passes. The [B05 document](xstate-effect-agents.md) separates these materialization checks from historical isolated/combined results and the preserved negative epoch control. Candidate `pnpm verify:static` passes ([output](evidence/xstate-effect/agents-candidate-static.log)); the focused agent/catalog/configuration/family and Access migration suite passes 65 tests in 10 files with default timeouts and two workers ([output](evidence/xstate-effect/agents-candidate-focused.log)); native Drizzle passes 49 cases and 41 persisted-state checks after SIGKILL/restart, including Agent and Access restoration ([output](evidence/xstate-effect/agents-candidate-native.log)). No source correction was needed. Full-unit/build, remaining native suites, browser and hosted CI remain pending; B05 is not committed or published.

This review stack contains B01, B04 and the B05 candidate with the scoped checks above. B02/B03/B06–B18 and F01–F15 remain open here. The following standard/witness sections preserve their original verification context; they are not new checks of the extracted candidate.

## Provenance and versions

The supplied [review archive](evidence/xstate-effect/review-evidence.zip), including its README, probes, manifest, logs, historical report and version pins, is preserved byte-for-byte and was extracted without modifying its original files. Archive SHA-256: `79cc729af8af8bbc6f05d1e4a30b28a668b15d29b1345b680e149d5aa126f56a`. All 12 SHA-256/size entries in its [manifest](evidence/xstate-effect/archive-manifest.txt) verified. Its original review commit is `d29803bc8fd8020cefffb5ce08a02a84a2e4f1df`. Its recorded 382 tests in 34 files are historical results; this change does not relabel that report as a current full-pipeline result.

Separate Git worktrees and separately installed frozen lockfiles were used for historical/current witnesses. New runs use Node `24.21.0`, pnpm `12.14.0`, Effect `4.0.5`, Pi Durable `1.3.0`, Agents `0.28.1`, and workerd `1.20261002.1`. The archive recorded Node `24.19.0` and available pnpm `11.25.0`; the runtime difference is retained in this evidence. No deployed-provider observation is claimed.

The selected exact integration pins are `@xstate/effect@1.0.0-alpha.8` and `xstate@6.0.0-alpha.68`. Published peer metadata accepts Effect `^4.0.0` and XState `^6.0.0-alpha.68`. Available alpha.9 instead requires alpha.70. Installed package types/README and the actual `admitSubmission`, PiHarness submission and Lifecycle implementation were inspected, then compiled and exercised. Package selection is not based on floating tags or indexed documentation alone.

## Historical witnesses, freshly revalidated

The archive's probes were run unchanged from its prescribed adjacent-checkout layout, with the Node 24 executable and each checkout's `tsx` loader:

```sh
node --import ./node_modules/tsx/dist/loader.mjs ../review-notes/distributed-probes.mts
node --import ./node_modules/tsx/dist/loader.mjs ../review-notes/terminal-admission-probe.ts
```

Both commands exited 0 on the historical SHA and initial current baseline, and were rerun after rebase onto `696aca98000a6e82a9cb202acc18f92f2c8e987e`. The current raw logs below record the rebased run. The distributed script asserts the old undesirable observation. Terminal is observational; its JSON was inspected for actual overlap/duplicate counts, not inferred from exit status. These scripts are historical witness revalidation, not regression tests asserting required corrected behavior. Required corrections are tracked in inventory B02–B04.

| Witness | Historical rerun | Current-base rerun | Classification and required property |
| --- | --- | --- | --- |
| W1 reply checkpoint | One synthetic provider call; `sending`, zero receipt parts, no next wake after another pump; explicit recovery gives `uncertain`. | Same. | **Reproduced.** Add owned/deadlined live sending or durable reconciliation. Preserve uncertainty; do not authorize resend from absent acknowledgement. |
| W2 background Stop | One Stop call despite two reconciliations; cancelled parent, no next wake, future authority false. | Same. | **Reproduced.** Retain stop obligation/acknowledgement or explicit unconfirmed outcome, independently of revocation. Pending handoff/unavailable stub does not establish a live runaway. |
| W3 Terminal admission | Distinct commands overlap at scheduler budgets 128/32; held transaction at 128 dispatches duplicate `first` twice behind one row. | Same. | **Reproduced.** Fresh atomic claimant alone dispatches; attempt-owned occupancy remains until joined cleanup. No deployed Cloudflare incidence established. |

Extract the preserved archive beside a checkout named `durable-pi` to reproduce the commands; the scripts intentionally resolve that sibling path. Raw outputs: [historical distributed](evidence/xstate-effect/historical-distributed.log), [current distributed](evidence/xstate-effect/current-distributed.log), [historical Terminal](evidence/xstate-effect/historical-terminal.log), [current Terminal](evidence/xstate-effect/current-terminal.log). Terminal schedules were `MaxOpsBeforeYield` 2048, 512, 128 and 32 with/without a held database transaction, plus duplicate identity at 128. No random seed. Controls at 2048/512 admitted one distinct command. Real Node SQLite and production Terminal code were used with a synthetic executor.

## New conformance and enforcement

`tests/xstate-effect.test.ts` verifies synchronous command extraction, no command on duplicate/stale events, revision/attempt/authority fencing, malformed input, unsupported invocation/timer descriptors, compatible domain-data restoration, incompatible versions, ordinary Effect invocation, controlled deadlines and joined cleanup. Runtime validation is configured on `setupEffect`.

`tests/architecture.test.ts` exercises import aliases, namespaces, re-exports, type-only imports, machine placement, legal core helpers and ordinary functions. `tests/architecture-cli.test.ts` invokes the actual configured Oxlint CLI with positive/negative source fixtures. These prove direct mechanical constraints; they do not prove semantic lifecycle coverage or distributed safety.

`node scripts/test-xstate-runtime.mjs` runs the actual native PiHarness, coordinated application/Pi SQLite and Lifecycle alarm owner. It commits an intent without dispatch and separately loses the local acknowledgement after Pi persists a result, SIGKILLs workerd, starts it again, waits without requesting the object, and verifies completed state and one synthetic model call per operation. Process-local failure-injection barriers prevent alarm dispatch before the first kill, so slow CI cannot accidentally complete either application handoff before the tested crash. Another SIGKILL/restart preserves completion. Repeated application admission is idempotent and conflicting payload reuse is rejected.

`node scripts/test-xstate-runtime.mjs --break-recovery` deliberately omits the pre-armed wake. It exits 1 with `committed: alarm must recover without a user request`, actual `pending` instead of `complete`. [Raw negative control](evidence/xstate-effect/broken-wake.log).

`pnpm exec vitest run tests/xstate-effect.test.ts` was also run after temporarily removing the exact `if (!owns(context, event)) return` fence lines. It exited 1 with two stale/restoration tests failing; the original machine bytes were restored and verified by hash before the passing suite. [Raw broken-fence control](evidence/xstate-effect/broken-fence.log).

An earlier exploratory run killed the lost-ack fixture while inference was still active and observed two synthetic provider calls. This is a material limit: native submission dedupe does not promise one model/provider execution before a checkpoint. The passing lost-ack test waits for native result persistence before killing; it proves that narrower reconciliation window.

## Verification ledger

Static, unit/build and the complete native suite were rerun locally after rebase. The local browser result precedes the rebase; CI ran it against the combined tree. Source review checked the acceptance transaction, dispatch/receipt path, failure controls, every inventory path and the diff against main. No independent human review or approval is implied.

| Command | Fresh result / scope |
| --- | --- |
| `pnpm prepare` | Exit 0; applied the repository's existing Effect compiler/Oxlint patches after frozen installation with scripts disabled. |
| `pnpm exec vitest run tests/architecture.test.ts tests/architecture-cli.test.ts tests/xstate-effect.test.ts` | Exit 0; 65 tests in 3 files, also included in the complete unit suite. |
| `node scripts/test-xstate-runtime.mjs` | Exit 0; both handoff cases complete, one model call, retained native receipt, two forced restarts. |
| `node scripts/test-xstate-runtime.mjs --break-recovery` | Expected exit 1; verifies wake-loss detection. |
| `pnpm verify:static` | Exit 0; secret scan, routes/migration checks, typecheck, lint and formatting passed. Staged-file scan rerun before publication. |
| `pnpm verify:unit-and-build` | Exit 0 after rebase; 2,153 tests in 212 files, website route checks and production website/Worker builds passed. Before rebase: 2,145 tests in 211 files. |
| `pnpm verify:native-runtime` | Exit 0 after rebase; communication, Drizzle (47 cases / 41 restart assertions), WhatsApp, memory, upstream observation and XState restart gates all passed. [Reference output](evidence/xstate-effect/native-reference.log). |
| `pnpm verify:browser` | Exit 0; 66 desktop/mobile tests, built passkey journeys and two-build stale-client recovery passed. |
| Required remote CI | All required jobs and aggregate `check` passed for `87ff00f` in [run 39867469758](https://github.com/cill-i-am/durable-pi/actions/runs/39867469758): static (including actionlint/complexity), unit/build, native and browser. Container jobs succeeded with builds skipped for unchanged inputs; deploy skipped. Final documentation-only updates are subject to the same [PR #200 head checks](https://github.com/cill-i-am/durable-pi/pull/200/checks). |

No merge, deployment, production reset, live email/WhatsApp send, or production provider exactly-once claim is part of this evidence. The [repository-wide goal](../BUILD.md#xstate-effect-lifecycle-refactor) remains open. B01 and the extracted B04 candidate have the distinct statuses recorded above; the remaining backend/frontend migration items still require their own implementation and proof.
