# Activity, saved evidence, and recovery

Inspect recorded work across your agents, see what needs attention, and follow the owning feature's recovery control.

## Sub-features

- `activity-timeline`: Browse per-agent or all-agent activity with stable paging and filters.
- `activity-history`: Reopen saved requests, answers, thinking, and tool arguments/results.
- `activity-inspectors`: Inspect plans, model attempts, delegated work, and named-agent tasks.
- `activity-partial`: Distinguish unavailable agent reads from an empty/idle result.
- `activity-recovery`: Follow specific approval, summary, backup, connection, or execution recovery links.
- `activity-errors`: Use a private client-error reference when a UI failure was actually recorded.

## How to get to it (user POV)

- Open `/agents/AGENT_SLUG/activity` or the account's Activity entry.
- Use **Activity agent**, **Filter activity**, and **Recent activity** to select a scope and record.
- Open **Saved agent activity**, **Run timeline**, **Durable run records**, or the corresponding work inspector.
- Follow an explicit recovery action from the entry instead of repeating the original task blindly.

## Driving it with the verification harness

Preconditions: Use an agent with known completed work and one harmless pending/error record. Do not create an external failure just to test its display.

- **Read saved work.** Open a completed entry, inspect the request and saved tool result, then reload. No new model request should be started by inspection.
- **Scope and filters.** Switch **Activity agent** to all agents, select a filter, page once, and return to a specific agent. Confirm the selected identities and state.
- **Error recovery.** Run `pnpm test:browser tests/browser/client-errors.spec.ts tests/browser/invitation-recovery.spec.ts --project=desktop`. A recorded report has a reference; failed logging must not invent one.
- **Checks.** Run `pnpm test tests/activity.test.ts tests/loop-recovery.test.ts tests/loop-recovery-ui.test.tsx tests/pi-loop-recovery.test.ts`.
- **Proof.** Keep the filtered scope, original record identity, opened receipt, and the result of any explicitly chosen recovery action.

## Gotchas

- Activity projects saved records; it is not a second execution queue and has no generic retry-all capability.
- Tool success and plan completion claims do not independently prove the user's external goal.
- Repeated tool failures have bounded recovery; denials and uncertain external actions must not be bypassed.
- A missing report reference can mean logging was unavailable. It does not mean the UI failure did not occur.
