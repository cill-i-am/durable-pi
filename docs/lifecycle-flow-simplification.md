# Lifecycle flow simplification

Ten bounded implementation passes are complete over dense adapters and guards after the verified `b7b465c` release. This work follows the domain ownership and frontend feature slices in [architecture](architecture.md), the [lifecycle standard](decisions/xstate-effect-state-machines.md), and Matt Pocock's [improve-codebase-architecture skill](https://github.com/mattpocock/skills/blob/main/skills/engineering/improve-codebase-architecture/SKILL.md).

## Constraints and done proof

Keep machine decisions authoritative and synchronous within domain transactions. Preserve persisted formats, event/attempt/revision identity, authority rechecks, uncertainty, retry budgets, retained wakes and joined Effect cleanup with full Cause. Keep native SDK translation inside each domain's adapters and frontend decisions inside their feature slice. Do not add a generic lifecycle engine or one-function forwarding modules.

Each pass must simplify a concrete flow behind an existing small interface, remove the superseded implementation, and pass its existing behavioral/restoration tests. Review the composed diff and run repository static, unit/build, native and browser gates. Commits are unsigned and conventional. The new work's verification is separate from the already deployed refactor.

## Pass ledger

| Pass | Flow | Change | Proof | Status |
| --- | --- | --- | --- | --- |
| 1 | Conversation root control | Name the domain eligibility rules and compare exact membership with sets. | `conversation-control, conversation-domain`: 20 tests passed; typecheck passed | Complete |
| 2 | Terminal command records | Concentrate versioned records and result projection in the Terminal domain. | `terminal-domain, terminal-claim`: 21 tests passed; typecheck passed | Complete |
| 3 | App event recovery lease | Separate the native job protocol and name lease eligibility inside the machine. | `app-lifecycle, app-delivery-machine, runner-boundaries`: 45 focused tests and composed static/unit/build passed | Complete |
| 4 | Routine warm owner | Own the shared actor lifetime in a routine-local module. | `routine-runner`: 20 focused tests and composed static/unit/build passed | Complete |
| 5 | Conversation queue protocol | Concentrate supported job forms in one adapter-local protocol. | `conversation-runner`: 50 focused tests and composed static/unit/build passed | Complete |
| 6 | Communication recovery ledger | Put durable epoch persistence and retry acceptance behind a small local interface. | `communication-runner`: 66 focused tests and composed static/unit/build passed | Complete |
| 7 | Workspace cleanup | Concentrate native job decoding, intent construction and stale-outcome projection; keep cleanup orchestration with its machine events. | `workspace-runner`: 44 focused tests passed | Complete |
| 8 | Memory summary controller | Concentrate controller read, commit and warm exhaustion retention. | `memory-summary-runner`: 26 focused tests passed | Complete |
| 9 | Memory backup recovery | Concentrate scheduler persistence and claim attachment while retaining distinct domain recovery. | `memory-backup-runner, memory-backup-lifecycle`: 39 focused tests passed | Complete |
| 10 | Model-default editing | Keep draft projections in the conversation feature and lifecycle targets in its machine. | `model-defaults-lifecycle`: 10 focused tests passed | Complete |

The independent exploration rejected seven parallel job-manager classes as shallow indirection. These passes preserve the external runner interfaces and keep internal modules private to their domain or feature. Existing characterization tests remain the test surface.

Review correction: pass 7 initially split cleanup behind nine callback dependencies. The deletion test rejected that shallow interface. The final pass keeps cleanup orchestration together and extracts the Workspace native job protocol instead.

## Composed verification

At application commit `90f4251669df7145e26a8d0f0f6a41eff7acfae7`, all 341 focused cases across fifteen files passed. The final composed `pnpm verify:static` and `pnpm verify:unit-and-build` runs exited 0: 3,918 tests in 334 files, website routing and all seven Worker builds. The final Workspace protocol was included in those runs. No existing behavioral assertions, stored formats or test deadlines were changed.

The independent architecture review checked all ten flows and the corrected Workspace protocol. It found no remaining semantic regression in exact callback identity, transaction-time reads, cancellation precedence, warm exhausted authority or joined full-Cause cleanup. This is agent review, not independent human approval.

The required hosted native-runtime, browser, static, unit/build and container results are recorded on [PR #232 checks](https://github.com/cill-i-am/durable-pi/pull/232/checks). Those checks govern delivery of this follow-up. The earlier [production release](xstate-effect-release.md) remains separately identified; its evidence does not cover this later refactor.
