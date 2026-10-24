# Routine runner shared lifetime

Invariants for this slice:

- Facades attached to the same native owner share one machine and one scoped lifetime. Creating another warm facade cannot reclaim a live callback, reset its retry budget or reopen a closed owner.
- Lifecycle owns the existing job identities, legacy payload compatibility, discovery lease and three attempts. Routines owns exact run/control-revision receipts and exhaustion eligibility inside its transaction.
- Only the exact failed callback may enter exhaustion, once. Running work, copied callbacks and concurrent exhaustion must not spend another dispatch or failure operation.
- Wake coalescing and serialized queue updates preserve existing retry identity and newer queue intent. Close refuses future calls and joins accepted storage/native work before runtime and SQLite disposal.

The new `routines/runner.machine.ts` is shared per native owner with one Effect scope. The WeakMap now retains only native actor/scope/Promise handles; callback phase, exact identity, receipts, wake coalescing, queue admission and closed state live in the machine. A later warm facade shares closed admission and cannot create a fresh owner. The former dispatch Map and active/wake flags are removed.

Two regressions fail against the preceding adapter: concurrent exhaustion calls through one facade or a second warm facade invoke domain exhaustion twice. The machine permits only one failed exact callback to exhaust. A real held-callback control also reproduces PersonalAgent disposing runtime/SQL before Routine work joins; Routine now joins alongside provider shutdown.

The combined tests exposed an existing Effect-to-Promise loss of checked/defect/interruption reasons. Routine and Conversation now carry the complete Exit through their native executor. PersonalAgent uses the existing complete-outcome bridge for both actual callback bindings. Removing the adapter correction fails eight tests; removing the two native binding corrections fails the actual native probe for both runners. The strengthened fixtures use checked Effect failures and retain original reason identities/annotations.

All 70 focused Routine/Conversation cases, static checks, all 3,754 unit tests in 330 files, website/route checks and all seven Worker bundles pass. Native Routine and Conversation recovery and the complete PersonalAgent/Communication suite also pass, including the final declared-storage-error probe. [Raw evidence and source hashes](evidence/xstate-effect/routine-runner-2026-10-24/README.md) retain each failure-sensitive control. Unsigned `982e245` is published in [draft #227](https://github.com/cill-i-am/durable-pi/pull/227); [hosted CI](https://github.com/cill-i-am/durable-pi/actions/runs/40130047898) is running. Other runner boundaries still require review of this conversion seam. No merge, deployment or live-provider delivery is claimed.
