# Tasks between named agents

Ask one existing agent to send a bounded text task to another and return its correlated result to the original request.

## Sub-features

- `bot-tasks-discover`: Discover active agents in the same account.
- `bot-tasks-send`: Send an explicit brief to one persistent named recipient.
- `bot-tasks-inspect`: Read requester, recipient, state, deadline, attempts, and result/blocker.
- `bot-tasks-control`: Cancel exact work or safely retry eligible delivery.
- `bot-tasks-return`: Correlate the reply with the original logical request after disconnect/restart.

## How to get to it (user POV)

- In chat, ask an agent to consult a specific other agent using `discover_bots` and `delegate_bot`.
- Open Activity → **Bot communication** for the saved task and deliveries.
- Use `check_bot_task` for a specific task; normal agents can also list/stop it through shared task controls.

## Driving it with the verification harness

Preconditions: Two active agents must belong to the same account. Use a supplied-text drafting question that needs no files or external actions.

- **Send.** Ask agent A to have agent B summarize a short supplied paragraph and return the result. Inspect the recipient choice and explicit brief before any Ask-policy approval.
- **Disconnect.** Leave the browser, reopen A, and confirm the result is attached to the original task rather than a new unsolicited request.
- **Inspect.** Open **Bot communication**, compare requester/recipient IDs and deadline, and inspect the saved result/blocker and delivery attempts.
- **Checks.** Run `pnpm test tests/communication.test.ts tests/communication-native.test.ts tests/communication-lifetime.test.ts`; `pnpm test:communication-runtime` covers actor/process recovery.
- **Proof.** Preserve A's brief, the accepted task identity, B's result, and A's correlated continuation.

## Gotchas

- This protocol is text-only, one hop, up to three tasks per originating request, with a ten-minute deadline.
- The recipient has no tools, implicit file/object access, or onward delegation. A normal chat opened directly in that agent has its usual tools instead.
- Delivery retries deduplicate admission; they do not promise exactly-once inference or external effects.
- An awaiting-input result is terminal for this protocol. It is not an ongoing polling conversation.
