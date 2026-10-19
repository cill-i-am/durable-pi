# Durable task plans

Follow an agent's objective, steps, blockers, and evidence for substantial work without maintaining a separate task list yourself.

## Sub-features

- `plans-objective`: Save objectives, constraints, completion criteria, steps, and next action.
- `plans-progress`: Update step states and blockers during ordinary execution.
- `plans-evidence`: Link saved tool, file, app, and object evidence and show its validation status.
- `plans-history`: Inspect revisions and retain context through compaction/restart.
- `plans-reopen`: Reopen progress when requirements or supporting evidence change.

## How to get to it (user POV)

- Ask an agent to complete a substantial request. It can use `update_plan` and `read_plan`.
- Open the agent's Activity panel at `/agents/AGENT_SLUG/activity` to inspect its plan, steps, evidence, and history.
- A project checklist is a separate shared object; see [Checklists](checklists.md).

## Driving it with the verification harness

Preconditions: Use a request large enough to justify a plan. A simple greeting is not a meaningful planning test.

- **Create through chat.** Ask: `Make a three-step plan for reviewing this supplied draft. Do not contact anyone.` Inspect the completed planning tool and Activity projection.
- **Inspect.** Open Activity, read the objective, expand **Plan steps**, and follow an evidence reference to its saved source.
- **Reopen.** Reload Activity and confirm the same plan revision. Change a requirement in chat and inspect the resulting revision rather than editing stored test state.
- **Boundary checks.** Run `pnpm test tests/planning.test.ts tests/planning-evidence.test.ts tests/planning-compaction.test.ts tests/planning-pages.test.ts`.
- **Proof.** Capture the request, plan revision, and the independently opened evidence. Agent-reported completion is not equivalent to validated external completion.

## Gotchas

- Plans do not grant tool permissions, schedule actions, or restart cancelled requests.
- Evidence validation checks owned saved sources; it does not turn every completion claim into external verification.
- Simple chat can complete without a plan. A checklist checkbox and a task-plan step are different records.
