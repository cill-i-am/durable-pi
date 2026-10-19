# Temporary research and background work

Let an agent split a bounded request into temporary branches, inspect their results, and receive a later report from background work.

## Sub-features

- `delegation-foreground`: Run up to three request-owned research/drafting children with explicit read tools.
- `delegation-background`: Run up to three tool-free text branches while the parent can finish its reply.
- `delegation-inspect`: Read briefs, states, reports, usage, and child transcripts.
- `delegation-control`: Use supported Activity steering/stopping for active branches/groups.
- `delegation-report`: Return a correlated result through durable conversation admission.
- `delegation-recover`: Preserve model pins, steering, cancellation, and report identity across interruption.

## How to get to it (user POV)

- Ask a normal agent for a task that benefits from independent research or drafting. It can use `delegate_tasks` or `background_tasks`.
- Open `/agents/AGENT_SLUG/activity`, then **Delegated work** or **Background work**.
- Inspect branches and **Child transcript**; use visible controls only while the parent/branch is eligible.

## Driving it with the verification harness

Preconditions: Supply bounded text and a harmless brief. Model-backed delegation requires available model access and the tool's existing policy.

- **Foreground.** Request two independent reviews of supplied text. Inspect each brief and the combined result, then open both child transcripts in Activity.
- **Background.** Request a later drafting report while allowing the parent to answer. Leave chat and confirm the correlated report appears once on return.
- **Control.** Stop a selected test branch/group through Activity or stop its owning request through shared task controls; distinguish the scope of each control.
- **Checks.** Run `pnpm test tests/delegation.test.ts tests/delegation-native.test.ts tests/delegation-ui.test.tsx tests/background-task-boundary.test.ts`.
- **Proof.** Record parent request, branch/group identities, combined/later result, and cancellation state after reopening.

## Gotchas

- Foreground children have explicit read-only tool subsets. Background branches have no tools and receive supplied text only.
- No recursive spawning is implemented. Child transcripts stay separate; the parent receives the combined report.
- Stopping a request stops its request-owned research. The newer shared task tool does not independently steer a request child.
- Temporary branches are not persistent named agents; see [Named-agent communication](bot-communication.md).
