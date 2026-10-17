# WhatsApp through Chat SDK

The owner requested the WhatsApp slice on 17 October 2026, using Chat SDK and deferring live provider testing. This record tracks consequential choices and verification.

| Decision | Consequence |
| --- | --- |
| Use the official `@chat-adapter/whatsapp` adapter and installed `agents/chat-sdk` state adapter. | Meta owns the business number and delivery; Cloudflare Durable Object SQLite retains SDK identity aliases and state. No Redis, second model harness or Vercel hosting is required. |
| Admit channel work into the existing Pi agents. | Conversations, memory, model access, Executor tools, approvals and cancellation retain their existing owners. A channel receipt pins its agent when admitted, so changing the active WhatsApp agent cannot redirect an older reply. |
| One business number and an explicitly configured owner sender identifier. | Unknown senders cannot discover agents, consume inference or receive private replies. `/agents` and `/agent <id>` switch among the owner's active agents; authenticated settings can also choose the route or disable it. Meta onboarding and the owner identifier must be configured before activation. |
| Acknowledge only after durable admission. | Chat SDK's temporary dedupe marker cannot suppress a provider retry after a failed admission. The adapter's signature verification and message normalization are retained; Pi's durable message identity owns dedupe and recovery. Handler failures propagate to a retryable webhook response. |
| Text first, within the customer-service window. | No incoming media downloads, proactive messages or unapproved templates. Replies are bounded to one provider text send and link to the full conversation. A closed window preserves the conversation for review in Pi. |
| Persist send intent before the provider call. | An interrupted or ambiguous send becomes uncertain and is not automatically repeated. Explicit retries require duplicate-risk acknowledgement where appropriate. Provider acceptance is recorded separately from delivery/read confirmation. |
| Keep approvals in authenticated pages. | WhatsApp may notify the owner that Pi needs review, but a message or interactive reply never grants tool authority. Executor continues to enforce its own browser approval/resume flow. |
| Keep webhook secrets and bodies out of invocation logs. | A dedicated ingress Worker disables invocation logging and moves the verification challenge into a private request body before forwarding. SDK logging is silent; only bounded generic failures escape. |

Sources: [WhatsApp adapter](https://chat-sdk.dev/adapters/official/whatsapp), [Cloudflare Chat SDK state](https://developers.cloudflare.com/agents/runtime/communication/chat-sdk/).

## Delivery checkpoint

Built from `origin/main` at `3d001f0`. Local verification passes 1,699 unit tests, static checks, application and Worker builds, and six existing desktop/mobile browser journeys. The official adapter is exercised with synthetic signed payloads, owner/media filtering, admission failure and replay, one bounded text send, and definite rejection versus uncertain transport or upstream failure.

Native workerd verification sends a synthetic WhatsApp request through the production PersonalAgent, its real Pi queue and SQLite receipts, then a synthetic provider actor. It produces one answer and one send, deduplicates repeated receipt, and retains the same result after process restart. A separate native test verifies the actual Chat SDK SQLite facets, lock exclusion, bounded lists and restart persistence. The existing native email interruption/recovery and Drizzle transaction suites remain release gates.

The user deferred live WhatsApp onboarding and message tests. The channel remains unavailable without Meta credentials, a business number ID and the explicitly configured owner identifier. No Meta account, number, provider access grant or live delivery is claimed. Main still requires a pull request and the aggregate `check`; local commits use the requested unsigned override.
