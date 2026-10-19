# Automatic attachment preparation

Accepted 19 October 2026. Receiving and preparing files belongs to Workspace; accepting a request and deciding when the model can run belongs to Conversations. Every surface uses the same intake and preparation path.

## Durable intake

Accept a request once with the original operation ID, selected file IDs, model route and skills. If a PDF or video is still processing, store `files_pending` in the existing conversation row and leave it queued. Do not create a second task, poll from the model, hold an HTTP request open, or require opening Files. Existing workspace jobs own bytes, extraction, bounded retries and derived assets. The existing Lifecycle scheduler owns durable wakes and restart recovery.

A shared workspace module decides whether all attachments are ready. Missing jobs are enqueued automatically; failed/empty results report the file's actual error and never restart on every poll. The conversation pump materializes input only after processing finishes. Final file eligibility, archive/cancel checks and the saved input share the original native admission transaction. A stopped request cannot start when preparation completes. Unsupported binary files remain stored-only with the existing explicit model notice; this slice does not invent text extraction or OCR.

## Failures and recovery

Preparation failures finish the request with a useful error before model submission. A preparation failure in a queued steering message stops the active run before completing its members; it must never silently discard the steering instruction. Original files and the request remain available. Existing workspace retry and conversation retry controls remain explicit.

## Delivery visibility

Expose confirmed and total provider-message counts from the frozen reply plan through a shared projection. Provider acceptance is not proof that the recipient read or received a message. Retry controls skip confirmed parts; uncertain sends still require acknowledgement because the unconfirmed part may already have reached the provider.

## Acceptance

Record real email journeys separately from deterministic adapter tests, native actor restart tests, hosted checks and deployment. WhatsApp provider onboarding remains parked.
