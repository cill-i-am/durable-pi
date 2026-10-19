# Temporary research and background work

Let an agent split a bounded request into temporary branches, inspect their results, and receive a later report from background work.

## Sub-features

- `delegation-foreground`: Run up to three request-owned research/drafting children with explicit read tools.
- `delegation-background`: Run up to three tool-free text branches while the parent can finish its reply.
- `delegation-inspect`: Read briefs, states, reports, usage, and child transcripts.
- `delegation-control`: Use supported Activity steering/stopping for active branches/groups.
- `delegation-report`: Return a correlated result through durable conversation admission.
- `delegation-recover`: Preserve model pins, steering, cancellation, and report identity across interruption.
- `delegation-spawn`: Start read-only children that continue after the parent replies, for up to ten minutes.
- `delegation-agents`: Discover the parent and peers in the current session.
- `delegation-sessions`: Let main agents discover other main sessions within the same private bot.
- `delegation-message`: Queue an addressed message with application-assigned agent authorship and reply references.
- `delegation-latest`: Read an agent's latest answer and its latest delivered message to the caller.

## How to get to it (user POV)

- Ask a normal agent for a task that benefits from independent research or drafting. It can use `delegate_tasks`, `background_tasks`, or `spawn_agents` for continuing collaboration.
- Open `/agents/AGENT_SLUG/activity`, then **Delegated work** or **Background work**.
- Inspect branches and **Child transcript**; use visible controls only while the parent/branch is eligible.

## Driving it with the verification harness

Preconditions: Supply bounded text and a harmless brief. Model-backed delegation requires available model access and the tool's existing policy.

- **Foreground.** Request two independent reviews of supplied text. Inspect each brief and the combined result, then open both child transcripts in Activity.
- **Background.** Request a later drafting report while allowing the parent to answer. Leave chat and confirm the correlated report appears once on return.
- **Control.** Stop a selected test branch/group through Activity or stop its owning request through shared task controls; distinguish the scope of each control.
- **Checks.** Run `pnpm test tests/delegation.test.ts tests/delegation-native.test.ts tests/delegation-ui.test.tsx tests/background-task-boundary.test.ts`.
- **Coordination.** Run `pnpm test tests/coordination.test.ts tests/coordination-native.test.ts tests/message-provenance.test.ts` and `pnpm test:communication-runtime`. The native journey checks a parent replying before its child finishes, an addressed clarification, automatic findings, and reuse of the original native session. It also checks that the continuing request remains in task status and can be stopped by its original handle.
- **Model choice.** With an explicitly selected model and API credential available, run `pnpm eval:coordination`. Missing credentials are not a pass. This uses synthetic prompts and never executes the selected tools; inspect the actual choices and authorship handling separately from runtime results.
- **Proof.** Record parent request, branch/group identities, combined/later result, and cancellation state after reopening.

## Gotchas

- Foreground children have explicit read-only tool subsets. Background branches have no tools and receive supplied text only.
- No recursive spawning is implemented. Child transcripts stay separate. `delegate_tasks` returns a combined report; `spawn_agents` reports completed child answers automatically and supports addressed messages.
- Stopping a request stops its request-owned research. The newer shared task tool does not independently steer a request child.
- Children can contact only their own session. Main-to-main discovery stays inside one private bot. Agent messages do not grant human approval; resumed main agents receive only coordination tools.
- Continuing groups have bounded requests, messages, and deadlines. Activity allows steering and stopping idle children until their group closes. Shared task status includes these sessions after the parent's initial reply.
- Temporary branches are not persistent named agents; see [Named-agent communication](bot-communication.md).
