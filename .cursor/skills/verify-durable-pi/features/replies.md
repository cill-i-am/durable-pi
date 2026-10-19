# Complete reply and file delivery

Receive the full saved answer and every selected reply file, even when a transport needs several messages, and retry only the unconfirmed remainder.

## Sub-features

- `replies-complete`: Preserve the answer rather than silently replacing it with a short preview.
- `replies-files`: Deliver explicitly selected workspace files with original bytes, filenames, and MIME types where supported.
- `replies-parts`: Freeze an ordered provider-message plan before sending and checkpoint each acknowledgement.
- `replies-progress`: Show confirmed/total provider-message counts and the next part.
- `replies-retry`: Skip confirmed parts on explicit retry and retain uncertainty for ambiguous sends.
- `replies-revoke`: Recheck channel authority between parts and recover fully checkpointed replies without another send.

## How to get to it (user POV)

- Ask for a long answer or selected files from web, email, or WhatsApp. Web shows answer/downloads; channel adapters apply their own message boundaries.
- In **Recent email** or **Recent WhatsApp replies**, inspect progress and **Retry remaining messages** where available.
- A **Delivery unconfirmed** state requires checking the recipient before **Send again**.

## Driving it with the verification harness

Preconditions: Live channel tests require that channel's configured and authorized recipient. WhatsApp is blocked on onboarding.

- **Recovery checks.** Run `pnpm test tests/reply-delivery.test.ts`. The tests preserve every text character/file, skip confirmed parts, handle revocation, and recover a fully checkpointed plan without another provider call.
- **Progress UI.** Run `pnpm test:browser tests/browser/email.spec.ts --project=desktop`. The fixture shows `1 of 3 messages accepted by the provider` and requires explicit resend confirmation.
- **Full text.** Through email, request numbered lines with a unique final marker. Verify every line and the marker in the received thread.
- **Multipart files.** Select files whose combined bytes exceed the per-email budget. Verify all threaded messages and compare every returned file's bytes, not just filenames.
- **Proof.** Count actual provider messages, correlate their plan progress, and record uncertainty explicitly. Do not inject a lost acknowledgement into a live provider just to manufacture a retry.

## Gotchas

- Email batches attachments within 16 MiB per message. WhatsApp splits Unicode-safe text and sends files separately.
- Provider acceptance does not establish inbox placement, device delivery, or reading.
- An unconfirmed part can already have arrived. Explicit resend can duplicate that part; confirmed parts remain skipped.
- Share-tool completion means file selection, not completed transport delivery. A private web link alone is not file-delivery proof.
