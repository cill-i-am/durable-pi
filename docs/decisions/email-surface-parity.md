# Agent URLs and email capabilities

Decisions from 18 October 2026. These extend the original [email slice](agent-email.md).

| Decision | Consequence |
| --- | --- |
| Persist a unique slug per account, derived from the agent's initial name. | URLs use readable names. ID URLs resolve to the same agent and become canonical slug URLs, including nested settings and file views. IDs remain the permanent actor/storage identity. |
| Keep slugs stable after renaming, reserve collection paths and ID values, and retain archived agents' slugs. | Old email links and bookmarks keep working and cannot silently select a different agent. Colliding names receive numeric suffixes. Existing names are backfilled transactionally without changing IDs, revisions or creation receipts. |
| Enable email by default when the environment is configured. | New and previously unconfigured agents can receive and reply without a separate enable step. An explicitly disabled channel remains disabled. Re-enabling revokes the old capability address. Missing deployment configuration still means unavailable email. |
| Treat files as ordinary assistant input/output. | Cillian explicitly authorized selected workspace files and full readable approval details to his enrolled Gmail inbox. Email remains scoped to that enrolled sender/recipient and agent's private workspace. Existing tool policies still apply. |
| Reuse the shared workspace pipeline. | Email transports binary MIME parts through a private multipart service request. SQLite keeps file IDs, not attachment blobs. Content detection, image preparation, transcription, document extraction and conversation admission use the existing workspace modules. File identities and message fingerprints fence retries and changed-message replays. |
| Make reply file selection surface-independent. | `share_file` records an existing private file for the current reply, alongside `share_image`. Cillian explicitly authorized default Allow for all existing and future agents across all surfaces; saved per-agent policies still override it. The web app renders the same reply files and the email adapter delivers selected files. No public file bucket or anonymous download link is introduced. |
| Bound email transport without arbitrary document restrictions. | Up to four supported workspace files, 8 MiB each, within 20 MiB raw incoming MIME. Outgoing binary attachments have a 16 MiB budget per email to leave MIME overhead within the verified recipient's 25 MiB provider limit. The [reply-delivery slice](reply-delivery.md) sends larger selections in additional threaded messages instead of replacing files with web links. |
| Use React Email, matching Meal Planner. | A readable action card shows the action title, complete labeled arguments, expiry and approve/deny choices. HTML escapes private/untrusted values. Every email retains a plain-text version. |
| Approve one operation with an explicit email reply. | A domain-separated HMAC binds the approval to the private agent address, operation ID, request, revision and expiry. Buttons open a prepared email; the user must send it. Opening mail or a URL cannot execute an action. Only a first-line `APPROVE` or `DENY` command decides; quoted text and ordinary agreement do not. |
| Keep durable authority and delivery semantics. | Revocation and a ledger decision share the actor database transaction. Existing revision, cancellation, expiration and dispatch checks remain authoritative. Notices are deduplicated per operation/revision and use the same claim-before-send outbox as replies. Interrupted/uncertain sends need explicit retry acknowledgment. Executor continues to own its own approvals. |
| Keep WhatsApp onboarding parked. | This release changes the shared file capability but does not configure Meta, Twilio, credentials or a new WhatsApp sender. |

## Verification

Unit and native checks cover the actual catalog, workspace, email pump and approval ledger. Browser checks cover ID-to-slug replacement, direct slug navigation and selected-view preservation. Live inbox/provider acceptance is a separate release gate; successful synthetic tests alone do not establish real delivery.

Live Gmail finding: Gmail folds a long approval command after its verb in the plain-text MIME part. Accept a token on the immediately following unquoted line, normalize the command before storing it, and discard the quoted card. A blank line or quoted mail cannot supply a missing token. The native approval round trip exercises this actual mail-client layout.

Provider references: [sending and attachment types](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/), [verified-destination limits](https://developers.cloudflare.com/email-service/platform/limits/), [React Email rendering](https://react.email/docs/utilities/render).
