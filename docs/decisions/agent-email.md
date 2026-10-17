# Agent email decisions

This log records the email slice started on 17 October 2026. Implementation is on `feat/agent-email`, tracking `origin/main`, initially fetched at `9aa3d48c1416402ee0eeb3ca83c429d47a89da52`. Existing changes in the primary checkout remain separate.

## Accepted decisions

| Decision | Reason and consequence |
| --- | --- |
| Use Cloudflare Email Service directly for the first channel. | Email has native Worker ingress and sending bindings. Vercel Chat SDK remains a candidate for later messaging channels; this slice does not add it or replace the Pi harness. |
| Admit email through the existing conversation queue. | Pi retains model execution, recovery, transcript ownership, memory, and tool approvals. Email is another request origin in the selected agent's existing conversation. It does not create an independent email-only memory or model session store. |
| Give each enabled agent a private capability address. | A `From` address alone cannot authorize agent work. A 128-bit HMAC-derived token binds the address to owner, agent, domain, and revocation generation. Both envelope and parsed sender must also match the enrolled owner. The private address is less friendly than a plain alias but can be revoked without relying on unproven header trust. |
| Require a separate email-address secret. | Domain-separated HMAC signing uses `EMAIL_ADDRESS_SECRET`, independently configured from login credentials. A missing domain or short/missing secret leaves email unavailable. Agents begin disabled even when environment configuration exists. |
| Isolate ingress in an HTTP-disabled Worker with invocation logging off. | SMTP recipients contain private capability tokens. The ingress Worker resolves the registered owner using D1 and calls the existing gateway through a private service binding. Provider-side processing and logs remain a Cloudflare concern; this choice prevents adding application invocation logs of these addresses. |
| Restrict outbound recipients to the enrolled inbox. | Both the application and native send binding constrain replies to `OWNER_EMAIL`. This channel grants no general email-sending tool or authority to contact other people. |
| Ship text first and reject unsupported input explicitly. | Plain text and HTML-only email are accepted; HTML becomes text using an iterative traversal so deeply nested input cannot exhaust the JavaScript call stack. Attachments, automated messages, and mailing-list mail are rejected. No attachment is silently omitted. Raw MIME is bounded at 256 KiB; body text is bounded at 25,000 characters. |
| Persist receipt identity and content before model admission. | A stable message identity becomes the conversation operation ID. Duplicate delivery reuses the receipt. The same identity with different content is rejected. Messages remain queued while the model is disconnected. |
| Persist a send intent before contacting the provider. | The channel and agent authority checks share the local transaction that claims the reply. A concurrent disable/archive can cancel an unclaimed send. A send that already crossed the provider boundary can finish. |
| Recover interrupted sends as uncertain. | The provider binding does not establish a reusable idempotency key for sends. Automatically retrying after a crash could duplicate mail. The UI requires inbox inspection and explicit duplicate-risk acknowledgement before resending an uncertain reply. Provider acceptance is recorded as Sent, not inbox-delivery proof. |
| Retain operation IDs for settings changes and durable receipts for every reply retry. | Repeating an unconfirmed request does not rotate the address or trigger another resend. Review found that retaining only the latest retry ID allowed an older tab to repeat a send after a newer retry failed. A separate receipt table binds each retry ID to its reply and duplicate-risk acknowledgement, including after later retries. A conflicting settings revision requires a reload. |
| Disabling email revokes incoming access and cancels unsent replies. | Re-enabling increments the address generation. Already admitted conversation work remains governed by the ordinary Stop and approval controls. Disabling the channel does not silently cancel that work. |
| Bound retained storage. | Each agent accepts up to 20 pending emails and 2,000 retained receipts, with at most 100 explicit retries per reply. Existing receipts are preserved when capacity is reached. Settings display the latest 30 receipts. A broader retention/cleanup policy is deferred. |
| Keep disable available when server configuration disappears. | A previously enabled channel can still be revoked from Settings when its domain or signing secret is unavailable. Re-enabling requires valid environment configuration and an active agent. |

## Verification decisions

- Exercise the real production PersonalAgent, Pi harness, Lifecycle, Drizzle storage, and process restarts in workerd. Only the model and external email provider are synthetic.
- Include duplicate inbound delivery, acknowledgement replay, disconnected-model waiting, address revocation, archive/disable authority, MIME limits, and failed/uncertain sends in focused tests.
- Test a SIGKILL after a provider call begins and before its result is saved. Recovery must expose uncertainty and must not dispatch another send.
- Check settings controls and explicit resend confirmation at desktop and mobile sizes. Browser transport fixtures do not prove production email delivery.
- Preserve existing migrations. Generate a separate additive migration and its checked manifest. Verify physical SQLite constraints rather than relying on TypeScript nullability.
- The generated migration must include `NOT NULL` on text primary keys. The installed generator omitted it for inline key declarations, so these tables use explicit table-level primary keys; schema tests inspect the resulting SQLite schema.
- The browser fixture's route shell now includes the real settings path. Without it, the fixture incorrectly interpreted `settings` as a workbench tool; production routes already declare this path.

## Delivery state and open decisions

- Local verification passed static/type/lint/format/secret checks, 1,668 unit tests, production app and Worker bundles, native communication/recovery and Drizzle suites, and four browser journeys across desktop/mobile. Browser screenshots and synthetic provider acceptance are local evidence only. CI/review and production activation remain separate release gates.
- The configured 1Password SSH signer timed out before creating the initial commit. The owner explicitly authorized an unsigned commit for this slice. Use a per-command signing override and preserve the saved Git signing configuration. Push and draft review follow the commit; production activation remains pending.
- Cloudflare's zone settings were read on 17 October: email routing was disabled and unconfigured. No DNS, routing, provider onboarding, or live mail mutation has been performed for this slice.
- `agents.cill-i-am.com` is the proposed production mail subdomain, pending activation. Configure only that subdomain's mail records and preserve the existing apex-domain mail setup.
- A concrete deployment needs the production domain variable and email-address secret, a subdomain routing rule to EmailWorker that preserves the complete `+` address, and verified outbound sender/destination configuration.
- Real inbox acceptance requires an owner-sent message, an agent reply, a reply to that thread, and matching Pi history. Local tests cannot check inbox placement, DNS propagation, or real authentication headers.
- Attachments, proactive notifications, friendly aliases with stronger sender verification, multiple enrolled senders, and additional messaging channels remain outside this slice.

The [build tracker](../../BUILD.md#agent-email-slice--17-october-2026) records verification and release evidence. The [README procedure](../../README.md#activate-email-delivery) describes activation.
