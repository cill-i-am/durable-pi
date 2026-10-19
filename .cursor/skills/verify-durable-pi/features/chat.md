# Conversations, steering, and cancellation

Send text and files, follow the response, steer active work, or queue a separate request without keeping the browser open.

## Sub-features

- `chat-send`: Admit a message once and retain its original files, model selection, and skills.
- `chat-stream`: Read saved text, thinking disclosures, tool inputs/results, and approval states as they arrive.
- `chat-steer`: Deliver guidance at the next tool boundary or queue a fresh turn.
- `chat-stop`: Stop a running request or cancel a queued/preparing request.
- `chat-reconnect`: Reopen committed progress after disconnect or restart.
- `chat-uncertain`: Recover an unconfirmed submission using its original operation identity.

## How to get to it (user POV)

- Open `/agents/AGENT_SLUG` and use **Message AGENT_NAME** and **Send message**.
- Attach through **Attach files** or **Choose files**. Review attachments before sending.
- During work, use the composer delivery controls for steering versus a separate turn; use the request's Stop or Cancel control.
- Messages from email and WhatsApp enter the same agent conversation after transport acceptance.

## Driving it with the verification harness

Preconditions: The browser fixture supports deterministic responses and queues. Real-model acceptance requires an available shared ChatGPT connection.

- **Send and reopen.** Run `pnpm test:browser tests/browser/workspace.spec.ts --project=desktop --grep 'sign in, open an agent'`. Attach the fixture photo, send, observe **Fixture reply received.**, and reload both answer and download link.
- **Queue.** Run `pnpm test:browser tests/browser/conversation-queue.spec.ts`. The first message starts immediately; a later message is shown as queued.
- **Preparation.** Run `pnpm test:browser tests/browser/workspace.spec.ts --grep 'send a PDF'`. A pending PDF request survives reload as **Preparing files…** with Cancel.
- **Steer and stop.** On a real test request, steer before a tool boundary, then stop the exact request. Reopen it and verify the saved stopped result and cancelled approval, not just the disappearing spinner.
- **Proof.** Preserve the action trace and a second read after reload. Fixture replies establish UI behavior only.

## Gotchas

- Disconnecting the browser or signing out does not cancel admitted work.
- Stop records cancellation intent; an already dispatched external action can finish. Check its provider before retrying.
- Thinking disclosures are separate from the searchable memory archive.
- Attachments that fail preparation produce a concrete error before model dispatch; they are not silently omitted.
