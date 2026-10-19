# Email conversations and approvals

Email an agent from the enrolled owner inbox, receive full answers and files in the same thread, and decide Pi tool approvals by an explicit reply.

## Sub-features

- `email-address`: Copy an agent's private address; configured new agents inherit email enabled.
- `email-intake`: Accept owner text/HTML mail and supported attachments into the same conversation.
- `email-thread`: Deliver full replies and selected files in threaded provider messages.
- `email-approval`: Read a styled action card with complete labeled arguments; explicitly approve once or deny.
- `email-controls`: Use STATUS and STOP while the model is busy.
- `email-recovery`: Inspect recent mail, revoke the address, or retry remaining unconfirmed reply parts.

## How to get to it (user POV)

- Open `/agents/AGENT_SLUG/settings/general` → **Email this agent**. Copy **Private email address**.
- Send from the deployment's enrolled owner inbox; reply to the agent's mail to continue the conversation.
- Approval buttons prepare a reply. Send that reply, or use the exact APPROVE/DENY command from the card.
- Use **Recent email** for delivery state and retry. **Disable email** revokes the address; re-enabling creates another.

## Driving it with the verification harness

Preconditions: Real email requires configured Cloudflare routing/sending and the enrolled sender. Use only explicitly authorized test correspondence. Keep the capability address and approval token out of artifacts.

- **Settings and retry UI.** Run `pnpm test:browser tests/browser/email.spec.ts`. Enable, cancel a resend confirmation, explicitly resend, and disable; verify one retry and no exposed address after disable.
- **Round trip.** Send a unique harmless question from the owner inbox. Confirm one request in Pi, a full inbox answer, and a working agent-slug link. Reply once and verify threading.
- **Files.** Attach a small PDF; ask for its unique sentence and original file. Download the returned attachment and compare bytes. Use [Reply delivery](replies.md) for multipart acceptance.
- **Approval.** Trigger a harmless Ask-policy action, read its full arguments, and explicitly send DENY. Confirm the saved denied result in Pi. Use APPROVE only when that exact test action is authorized.
- **Checks.** Run `pnpm test tests/email.test.ts tests/email-surfaces.test.ts tests/approval-card.test.tsx tests/approval-decision.test.ts`.
- **Proof.** Record sent mail, Pi admission, received reply/attachment, and stored decision as separate observations.

## Gotchas

- Replies and approval notices go to the enrolled deployment-owner inbox. Arbitrary outbound mail and family-member inbox routing are separate capabilities.
- An email open or button click does not approve an action; sending the signed decision does. Quoted/prose agreement is not approval.
- Executor owns its own approvals and may require its browser page.
- Incoming limits: four supported files, 8 MiB each, 20 MiB raw MIME, and 25,000 body characters. Automated mail and mailing lists are rejected.
- **Sent** means provider acceptance, not inbox placement or reading. Disable can stop unsent replies; an in-flight send can finish.
