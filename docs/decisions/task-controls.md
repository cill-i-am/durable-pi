# Shared task status and stop controls

Date: 2026-10-19

## Decision

Tasks are existing conversation requests, bot-to-bot requests and background groups. Add a read/control projection over those records, not another task ledger or scheduler. A request-owned research group remains controlled by stopping its original request. Independent child steering, continue and clarification are later slices.

Every active named agent exposes `list_tasks` and `stop_task`, using the same account scope as the web gateway. These tools default to Allow and remain subject to per-agent tool overrides. Child execution keeps its existing tool grants; this does not grant tool-less recipients new tools or allow access to another family member's account. Read agent names/slugs from the account catalogue, recheck the active target through the existing gateway and use the target domain's original cancellation operation.

Read status by a human slug or across all agents. Stop requires an exact handle containing stable agent ID, task kind and original task ID. Renames and a newer active request cannot redirect an old control. No stop-current or implicit stop-all operation is introduced. Return the recorded state and distinguish accepted cancellation from cleanup still settling; completed external actions are not undone.

Email and WhatsApp recognize explicit leading STATUS, STATUS all, STATUS <slug> and STOP <handle> commands (slash prefixes also work). Attachment-bearing input and commands inside quoted/prose text remain ordinary conversation input. Controls run from already accepted transport records, independently of a busy model queue. Save the control reply before provider send and use the existing complete-reply delivery pipeline. If a crash loses that checkpoint, replay can only repeat the same idempotent cancellation target. Unknown/malformed commands return help and do not guess another task.

No new storage, migration, provider integration or secret. WhatsApp onboarding stays parked; its adapter is exercised locally and in native CI.
