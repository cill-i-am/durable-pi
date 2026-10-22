# Application lifecycle architecture

Application-owned lifecycles **must** be explicit XState machines built through the official `@xstate/effect` integration. This applies to existing and future backend and frontend lifecycles whenever permitted behavior depends on state over time: admission, async completion, cancellation, retries, approvals, resource ownership, or recovery. Complexity is not a prerequisite.

Effect owns work, dependencies, interruption and resource lifetimes. Pure functions own pure computation and validation. Pi owns durable agent/task execution and recovery; domain storage owns application persistence; Lifecycle owns durable wakes; Access owns authorization. Do not build a competing engine.

Read the [canonical standard](docs/decisions/xstate-effect-state-machines.md) before changing lifecycle control. Define machines in their owning domain or feature as `*.machine.ts`; supply infrastructure through capabilities. Start local machines with `createEffectActor` in an explicitly owned Effect scope. Keep synchronous machine decisions inside durable transactions and external work outside them. Preserve receipts, identity/revision fencing and uncertainty.

The [repository-wide goal](BUILD.md#xstate-effect-lifecycle-refactor) and its [inventory](docs/xstate-effect-inventory.md) track all migrations and justified exclusions. A status field, pure transformation, query projection or SDK-internal state alone does not require an application machine. Unmigrated lifecycles are open work, not exemptions. A migration is complete only when the machine decides progression and superseded control paths are removed.

Run the affected behavioral and restoration tests and the repository checks in `package.json` and `.github/workflows/check.yml`. Lint checks mechanical seams; it cannot prove lifecycle coverage or distributed recovery. Never replace those proofs with a dependency import or a machine mirroring writable legacy state.
