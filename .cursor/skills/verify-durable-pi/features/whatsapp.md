# WhatsApp conversations

Use the implemented Chat SDK adapter to talk to a selected agent through text and supported media once the external WhatsApp account is configured.

## Sub-features

- `whatsapp-owner`: Admit only the configured owner sender on the business number.
- `whatsapp-route`: List agents and change the selected agent while preserving earlier requests' original targets.
- `whatsapp-media`: Import images and voice notes into the common workspace pipeline; retain captions on image requests.
- `whatsapp-replies`: Return full text and original files as checkpointed provider messages.
- `whatsapp-controls`: Read task status and stop an exact task outside the model queue.
- `whatsapp-recovery`: Inspect recent replies, a closed service window, rejected sends, and uncertain-send retries.

## How to get to it (user POV)

- As the owner, open personal **Settings → Channels** at `/settings/channels` to inspect WhatsApp availability. Choose an active owned agent in **WhatsApp agent**, then explicitly enable or save the route. The settings backdrop does not choose the recipient.
- WhatsApp enablement/routing is one account-wide channel. Recent replies retain their original agent labels when the route changes. Email settings remain in each agent's General settings.
- After onboarding, message the configured business number from the configured owner.
- Send `/agents` or `/agent AGENT_ID` to choose an agent. Send `STATUS`, `STATUS all`, `STATUS AGENT_SLUG`, or `STOP HANDLE` for controls.
- Pi tool approvals link back to the authenticated app; WhatsApp approval decisions are not implemented.

## Driving it with the verification harness

Preconditions: Live provider onboarding is parked. No real WhatsApp sender or successful live acceptance is established by this map.

- **Adapter checks.** Run `pnpm test tests/whatsapp.test.ts tests/whatsapp-chat.test.ts tests/whatsapp-images.test.ts tests/task-channel-controls.test.ts`.
- **Native persistence.** Run `pnpm test:whatsapp-runtime` for real actor-backed Chat SDK state. These checks use synthetic provider boundaries.
- **Future live journey.** After configuration, send text, switch agents, redeliver the same message, and compare Pi's admitted requests. Earlier messages must retain their original agent.
- **Media and controls.** Send an image with caption and a voice note separately. Verify retained originals/prepared input, then ask for a workspace document as an outbound file. Request STATUS during a harmless approval wait and stop only that task.
- **Proof.** Mark these live journeys blocked until provider configuration exists. Preserve actual provider messages and matching Pi records when run.

## Gotchas

- Meta/Twilio onboarding remains deliberately parked. Source and native tests are not evidence of a working production WhatsApp connection.
- The inbound parser accepts text, images, and audio only. PDF/video/document intake is not implemented; the shared preparation pipeline alone does not make the transport accept those messages. Outbound selected files use the broader export adapter.
- The reply adapter enforces the customer-service window; expiry preserves the request for review rather than inventing an authorized proactive template.
- Voice notes receive text. Real-time calls, TTS, proactive templates, and approve/deny by WhatsApp are not implemented.
- One configured owner sender is supported. Adding another person requires participant routing and authorization work.
- Changing the target affects new messages; it does not move earlier requests. Disabling WhatsApp affects the account channel, not just the agent visible behind Settings. Existing owner-only entitlement and family admission remain unchanged.
- Provider media limits can reject a file even when it is valid in Pi. Rejected or uncertain sends remain visible.
