# Memory maintenance runner lifetimes

**Release status — 25 October 2026:** the refactor is [merged, deployed and verified](xstate-effect-release.md). The checkpoints below retain their original source and test scope; pre-merge delivery status is historical.

Summary and Backup retain their existing durable controllers, dispatch machines, native model/bucket ownership, discovery deadlines, exact recovery epochs and receipts. `memory/runner-host.machine.ts` now owns their common local activation and closed admission. Each runner has its own instance through `MaintenanceRunnerHost`; no shared runtime, journal or business retry budget is introduced.

The machine separates admission from cold/restoring/ready activation. The scoped host starts lazily in the first native caller's context. Synchronous eligibility reads project the existing state and never start actors inside SQL transactions. Restoration is coalesced, successful restoration is retained, and only a request observing a later cold attempt may retry a failed restoration. Each request carries the generation it observed before enqueueing: native child completion can overtake a queued request, but that request must receive the same attempt's result. The failed coalescing check demonstrates why enqueueing alone is insufficient.

Close refuses new work and retained recovery leases, signals existing native owners, joins accepted storage/restoration/dispatch/cleanup work, and only then closes its actor scope. Serial Promise gates remain native serialization handles; they no longer decide restoration or closed admission. Ordinary admission refusal remains a caller result. Defects and compound failure/interruption during accepted storage settlement survive disposal with their original reasons, alongside existing native cleanup failures.

Reproduced corrections:

- Summary disposal previously returned while cold restoration or an accepted controller read remained held. Both regressions fail against the preceding source.
- Summary post-close wake/status/callback paths could still query storage; Backup's retained lease could query closed storage. Closed calls now stop before those reads.
- The initial migration discarded compound storage settlement failures in a fulfilled serialization gate. Four negative cases with/without defects now preserve the complete original Cause at admission and disposal.
- The local restoration generation prevents an already-requested join from becoming another restoration after its original attempt fails.

One older Summary test awaited full disposal before releasing its held storage read. It now asserts disposal remains pending, releases the read, then checks that no native work was admitted. The deadline and native-admission assertions are unchanged. The native Summary inspector previously called the production recovery API after stopping its runner. It now reads the retained controller through fixture-only native ledger instrumentation, like its other post-close observations; it does not reopen the closed owner.

Focused verification passes 58 cases across the Summary runner, Backup runner and common host. This covers existing receipt/recovery behavior, held work, original cleanup failures, coalescing and failed-restoration retry, native startup context, post-close storage refusal, malformed events and complete annotated Causes. Native Summary, Backup and full PersonalAgent checks pass, as do static checks, all 3,725 unit tests in 330 files, website/route verification and all seven Worker bundles. The first full unit run had worker startup/termination errors after 3,712 passing tests; the affected files and full suite passed unchanged on rerun. [Raw publication evidence](evidence/xstate-effect/memory-runner-2026-10-24/README.md) retains both results and final source hashes. No frontend or container source changes. Unsigned `068158f` is published in [draft #225](https://github.com/cill-i-am/durable-pi/pull/225); all required [hosted checks](https://github.com/cill-i-am/durable-pi/actions/runs/40128038459) passed. Deployment was skipped.

Conversation, Communication, Workspace and Routine callback owners remain open. No merge, deployment or live provider delivery is claimed.
