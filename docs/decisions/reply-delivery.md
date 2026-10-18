# Complete reply delivery across surfaces

Accepted 18 October 2026. Conversations, permissions and workspace files retain their current owners. The new replies module owns a small shared delivery interface; email and WhatsApp adapters own provider presentation and payload limits.

## Reply plans and recovery

Freeze the complete answer and explicitly selected workspace file IDs into provider-call parts before the first send. Store the versioned plan, channel generation and confirmed provider receipts in a nullable JSON column of each existing channel ledger. File bytes remain in the private workspace. Existing rows without plans retain their admission and recovery behavior; this is an additive migration.

One part corresponds to one provider message. Claim each part under the existing actor transaction and recheck channel/agent authority before dispatch. Checkpoint each provider acknowledgement before advancing. A restart never automatically repeats an uncertain send. Explicit retries preserve the original plan and skip confirmed parts. If every part was checkpointed before a crash, recovery can mark the reply sent without contacting the provider.

## Provider adapters

Email keeps complete answer text and batches selected files within a 16 MiB attachment budget per message. Additional batches stay in the same email thread. File-size limits cause additional messages, not silent omission or a web-only replacement.

WhatsApp splits complete text without dropping characters or splitting surrogate pairs. Each file is a separate SDK send with no caption, so an SDK-generated text-plus-media sequence cannot hide multiple messages behind one receipt. Export original bytes, filenames and MIME types through the shared workspace reader; provider-enforced media limits still apply and rejected sends remain visible. Existing permissions and default Allow for share_file are unchanged.

WhatsApp onboarding remains parked. Verify transport behavior with synthetic provider tests and native actor recovery; claim live WhatsApp acceptance only after its real provider setup is completed. Approvals/task controls, automatic attachment preparation, participant mapping and broader cross-surface scenarios are retained in the Durable Pi Space for later work.
