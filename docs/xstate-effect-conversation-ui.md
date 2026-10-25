# Conversation connection and draft ownership

**Release status — 25 October 2026:** the refactor is [merged, deployed and verified](xstate-effect-release.md). The checkpoints below retain their original source and test scope; pre-merge delivery status is historical.

F01 replaces the conversation connection, draft persistence, submission and per-turn command control paths with scoped actors from the official XState/Effect integration. Pi and the backend conversation ledger still own execution, receipts and cancellation. TanStack still interprets the SSE protocol and projects the transcript.

## Owners and invariants

`connection.machine.ts` owns stream attempts, cursor continuation, the existing five-failure recovery budget and terminal denial. `connection-owner.ts` joins the installed SDK iterator and native response cleanup before another fetch can start. Frames reset the retry budget; denied authority terminates it. Reconnection reads the conversation and never resubmits a turn.

`composer-draft.machine.ts` serializes persistence and associates each acknowledgement with its draft revision. Newer text, attachments and model choices survive an older save or submission acknowledgement. Existing compatible browser drafts retain their format and identities; unreadable or future data preserves its bytes, blocks replacement writes and prevents unsafe reload. Failed persistence makes no submission request.

`submission.machine.ts` captures immutable input, persists its attempt before dispatch, and retains that attempt when acknowledgement is uncertain. Explicit retry reuses its identity. The machine distinguishes server acceptance from local acknowledgement persistence, so a failed local write cannot authorize a new send. It never adds an automatic business retry.

`turn-command.machine.ts` owns each exact recovery or cancellation request. Stop remains available while an independent retry acknowledgement is held. Repeated Stop for the same target joins that request; closing the view joins outstanding native requests without claiming that remote work has stopped.

The React hooks own actor scopes and subscriptions. React state projects snapshots; it does not make a second decision about attempts or cleanup. The browser draft remains the reload guard's authority. These machines add no backend schema or second execution journal.

## Evidence and limits

The preserved independent probes reproduced replacement-fetch overlap during held SSE cleanup, unavailable Stop during a held retry, and automatic retry after a known authorization denial whose cleanup failed. The corrected actual installed-SDK path joins response cancellation, retains the original denial and full cleanup failure, and makes one fetch for 401/403/404. Draft and submission tests exercise unreadable storage, failed writes, exact restored uncertainty and newer edits during acknowledgement.

The F01/F02 independent review passed five unchanged probes and 53 focused tests across seven files. Their archived manifests identify the exact source checkpoint and distinguish earlier browser checks from subsequent cleanup-only repairs. The combined frontend publication record supplies final integration checks; the domain checkpoints alone do not establish hosted CI or production behavior.

The tests use local synthetic transports. Native cleanup must eventually settle before its owner can finish closing. No real model send, provider delivery, deployment or remote exactly-once guarantee is claimed.
