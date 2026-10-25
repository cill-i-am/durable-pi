# Memory runner lifetime evidence

The manifest retains raw checkpoint logs and final source/test hashes on top of App-runner commit `6801492`. Raw logs retain original whitespace.

Meaningful negative controls:

- `memory-runner-before.log.txt`: the preceding Summary adapter returns from disposal before held restoration or an accepted storage read finishes.
- `memory-runner-after-first.log.txt`: an old test awaited disposal before releasing a storage read; it was strengthened to assert pending disposal, then release and verify no native admission. The same checkpoint exposed ordinary admission refusal incorrectly counted as cleanup failure.
- `memory-runner-after-host.log.txt`, `memory-runner-after-enqueue.log.txt` and the coalescing diagnostic: native completion can overtake an already-enqueued restore request. Enqueueing synchronously alone does not fix it. A machine-owned observed generation keeps that request attached to the original attempt; the same test then passes.
- `memory-runner-storage-cause-before.log.txt`: four held storage cases lose compound failures at disposal through a fulfilled serial gate. The final native-settlement observer preserves all original reasons while ordinary request refusal remains a caller result.
- `memory-runner-native-summary.log.txt`: the old native inspector called the production recovery API after closure. Fixture-only ledger inspection now observes those retained records without reopening the runner; all original native assertions remain.

Final local results:

- `memory-runner-focused-final.log.txt`: 58 focused cases across Summary, Backup and the shared host.
- `memory-runner-unit-complete.log.txt`: the initial full suite had worker startup/termination errors after 3,712 passing tests. These were infrastructure failures, not a successful full-suite result.
- `memory-runner-worker-start-recheck.log.txt`: all three affected files pass unchanged (14 tests).
- `memory-runner-unit-recheck.log.txt`: the unchanged full suite passes all 3,725 tests in 330 files, using two workers.
- `memory-runner-static-complete.log.txt`: static checks, including types, lint, format and migration manifest. The publication secret scan separately includes staged new files.
- The three `native-*-complete` logs: actual Summary and Backup recovery/restart, exact receipts/bounded budgets, plus full PersonalAgent activation and joined cleanup. Native provider callbacks are synthetic; SQL, jobs, Pi and runtime are real.
- `build-complete`, `website-routes-complete` and `workers-complete`: website, route verification and all seven Worker bundles.

No frontend/container source changes; the parent PR has all required CI passing. Hosted checks on this new commit remain a separate publication gate. Four other runner boundaries remain open. No merge, deployment or live-provider delivery is claimed.
