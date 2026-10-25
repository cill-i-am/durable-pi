# Lifecycle flow simplification

Goal: complete ten bounded passes over dense adapters and guards after the verified `b7b465c` release. This work follows the domain ownership and frontend feature slices in [architecture](architecture.md), the [lifecycle standard](decisions/xstate-effect-state-machines.md), and Matt Pocock's [improve-codebase-architecture skill](https://github.com/mattpocock/skills/blob/main/skills/engineering/improve-codebase-architecture/SKILL.md).

## Constraints and done proof

Keep machine decisions authoritative and synchronous within domain transactions. Preserve persisted formats, event/attempt/revision identity, authority rechecks, uncertainty, retry budgets, retained wakes and joined Effect cleanup with full Cause. Keep native SDK translation inside each domain's adapters and frontend decisions inside their feature slice. Do not add a generic lifecycle engine or one-function forwarding modules.

Each pass must simplify a concrete flow behind an existing small interface, remove the superseded implementation, and pass its existing behavioral/restoration tests. Review the composed diff and run repository static, unit/build, native and browser gates. Commits are unsigned and conventional. The new work's verification is separate from the already deployed refactor.

## Pass ledger

Candidate selection is in progress using an independent codebase walk. Record each chosen flow, the removed complexity, its verification and completion here before closing the goal.
