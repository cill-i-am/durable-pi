# Lifecycle flow simplification

Goal: complete ten bounded passes over dense adapters and guards after the verified `b7b465c` release. This work follows the domain ownership and frontend feature slices in [architecture](architecture.md), the [lifecycle standard](decisions/xstate-effect-state-machines.md), and Matt Pocock's [improve-codebase-architecture skill](https://github.com/mattpocock/skills/blob/main/skills/engineering/improve-codebase-architecture/SKILL.md).

## Constraints and done proof

Keep machine decisions authoritative and synchronous within domain transactions. Preserve persisted formats, event/attempt/revision identity, authority rechecks, uncertainty, retry budgets, retained wakes and joined Effect cleanup with full Cause. Keep native SDK translation inside each domain's adapters and frontend decisions inside their feature slice. Do not add a generic lifecycle engine or one-function forwarding modules.

Each pass must simplify a concrete flow behind an existing small interface, remove the superseded implementation, and pass its existing behavioral/restoration tests. Review the composed diff and run repository static, unit/build, native and browser gates. Commits are unsigned and conventional. The new work's verification is separate from the already deployed refactor.

## Pass ledger

| Pass | Flow | Change | Proof | Status |
| --- | --- | --- | --- | --- |
| 1 | Conversation root control | Name the domain eligibility rules and compare exact membership with sets. | `conversation-control, conversation-domain`: 20 tests passed; typecheck passed | Complete |
| 2 | Terminal command records | Concentrate versioned records and result projection in the Terminal domain. | `terminal-domain, terminal-claim`: 21 tests passed; typecheck passed | Complete |
| 3 | App event recovery lease | Separate the native job protocol and name lease eligibility inside the machine. | `app-lifecycle, app-delivery-machine, runner-boundaries`: 45 focused tests and composed static/unit/build passed; native CI pending | Implemented |
| 4 | Routine warm owner | Own the shared actor lifetime in a routine-local module. | `routine-runner` | Planned |
| 5 | Conversation queue protocol | Concentrate supported job forms in one adapter-local protocol. | `conversation-runner` | Planned |
| 6 | Communication recovery ledger | Put durable epoch persistence and retry acceptance behind a small local interface. | `communication-runner, communication-control-runtime` | Planned |
| 7 | Workspace cleanup | Give cleanup-only settlement one internal operation, retaining exact claim fences. | `workspace-runner` | Planned |
| 8 | Memory summary controller | Concentrate controller read, commit and warm exhaustion retention. | `memory-summary-runner, memory-summary-runtime` | Planned |
| 9 | Memory backup recovery | Concentrate scheduler persistence and claim attachment while retaining distinct domain recovery. | `memory-backup-runner, memory-backup-lifecycle, memory-backup-runtime` | Planned |
| 10 | Model-default editing | Keep draft projections in the conversation feature and lifecycle targets in its machine. | `model-defaults-lifecycle, model-defaults-ownership` | Planned |

The independent exploration rejected seven parallel job-manager classes as shallow indirection. These passes preserve the external runner interfaces and keep internal modules private to their domain or feature. Existing characterization tests remain the test surface.
