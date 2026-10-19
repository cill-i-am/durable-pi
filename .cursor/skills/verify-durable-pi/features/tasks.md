# Task status and stop across agents

Ask any normal agent what is running across your account and stop one exact task, including from email or WhatsApp while a model request is busy.

## Sub-features

- `tasks-list`: Read unfinished requests, named-agent tasks, and background groups for one agent or all agents.
- `tasks-state`: Distinguish preparing files, approval waits, running, stopping, and unavailable agents.
- `tasks-handle`: Return a stable agent-ID/kind/original-task-ID handle.
- `tasks-stop`: Request cancellation through the task's original owner without stopping newer work.
- `tasks-channel`: Execute leading STATUS/STOP commands independently of the busy model queue.
- `tasks-scope`: Apply account boundaries and existing per-agent tool overrides.

## How to get to it (user POV)

- In any normal named-agent chat, ask `What is running across my agents?` or ask to stop a specific listed task. The agent uses `list_tasks` and `stop_task`.
- Email or WhatsApp first line: `STATUS`, `STATUS all`, `STATUS AGENT_SLUG`, or `STOP HANDLE`. An optional slash is accepted.
- Inspect the same request in chat/Activity; background and named-agent task views keep their existing controls.

## Driving it with the verification harness

Preconditions: Use a harmless test request paused at an approval. Keep another request distinguishable so cancellation cannot pass by stopping the wrong work.

- **Exact-target checks.** Run `pnpm test tests/task-controls.test.ts tests/task-channel-controls.test.ts`. Verify renamed agents, foreign handles, unavailable targets, checkpoint recovery, and preserved older email replies.
- **Natural language.** Ask a different agent for status without naming the tool. Inspect the actual completed `list_tasks` call and returned task handle.
- **Cross-agent stop.** Ask it to stop only the named test task. Inspect `stop_task`, then reopen the target agent and confirm stopped state and its cancelled approval.
- **Out-of-band control.** Send `STATUS all` and then `STOP HANDLE` by email while the approval waits. Confirm control replies arrive before the blocked model could answer.
- **Proof.** Record the exact original handle, cancellation acknowledgement, and independently observed final state. WhatsApp live proof remains blocked.

## Gotchas

- A stop acknowledgement can report **stopping** while cleanup settles. It cannot undo completed actions.
- There is no implicit stop-current or stop-all operation. A copied old handle cannot target a newer task.
- Attachment-bearing input and commands in quoted/prose text remain ordinary conversation input.
- Normal agents receive the tools by default with Allow; explicit overrides and restricted child grants remain authoritative.
- Continue, retry, clarification, and separate request-child steering are not supplied by this shared task-control slice.
