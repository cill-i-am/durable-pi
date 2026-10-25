# Objects UI lifecycle ownership

F07 migrates checklist editing, save recovery, reads, creation and origin dialogs to the official `@xstate/effect` integration. The source is in `src/features/objects`. Backend Objects/Pi authority, public mutation schemas and mutation digests are unchanged. This is a frontend migration above backend B14.

## Owners and invariants

| Owner | Decisions and resources |
| --- | --- |
| `object-edit.machine.ts` | One actor per object: clean/editing, retaining, saving, persisting, conflict, uncertain, failed and cancellation. It admits one immutable mutation, persists intent before dispatch, and decides explicit retry, cancel, reapply and dismissal. |
| `object-read.machine.ts` | A separate actor per read resource replaces observers and fences late responses. A read cannot submit, reapply or cancel a mutation. |
| `object-poll.machine.ts` | Four-second observation while there is an active consumer or pending mutation and the document is visible. Reconnection only refreshes queries. |
| `object-creation.machine.ts` | Creation form lifetime and post-save navigation. Selected-view revisions fence late completion, including A→B→A changes. |
| `object-origin.machine.ts` | Origin-dialog open, loading, failed and closed progression. Closing the dialog fences completion and interrupts its local read. |
| `ObjectStore` / React owners | Explicit Effect scope, actor registry, native HTTP capabilities and external-store projections. Scope closure aborts native requests and joins their actual settlement. Cleanup rejects with the full Effect Cause, including accompanying checked failures and defects. |

The old writable busy maps, pending/problem transition branches, in-flight promise admission, replacement bookkeeping and imperative polling no longer decide progression. Store maps now project actor context or cache query data. `ObjectStore.dispose()` closes admission and joins its actors; the provider creates a new owner for each agent identity and on effect remount. Mounted old-agent callbacks cannot populate the new agent's context.

Retry uses the entire retained `ObjectMutation` unchanged: object ID, operation ID, expected revision, action/task IDs and surface. The backend therefore computes the same digest. A conflict is never automatically retried. Explicit reapply creates one new operation ID at the reviewed revision, preserves the action, and records the replaced operation lineage. Further conflicts remain actionable; eventual acknowledgement settles that lineage. Cancel sends the original operation ID and requires a Boolean `applied` acknowledgement before discarding browser intent. Local observer interruption never confirms backend cancellation.

Save acknowledgement and browser retention are distinct. If removing or updating a retained record fails after a server response, the same attempt remains uncertain. A subsequent explicit retry rejoins it. Restoring browser records never dispatches a mutation. Pending forms keep their original values during uncertainty; editor closure follows acknowledged save/cancel or explicit dismissal. Text fields, checklist transformations, summaries, histories and status labels remain plain data/projections.

## Browser data compatibility

The session key remains `pi:object-changes:<agentId>`. Existing unversioned `ObjectMutation[]` records restore as uncertain attempts with unchanged identities/content. Nonempty writes now use `{ schemaVersion: 1, workflowVersion: 1, drafts: [...] }`; each draft contains its immutable input, pending fact, problem and reapply lineage. Empty storage remains the legacy `[]` representation.

A persisted pending record with no problem represents interruption between intent persistence and acknowledgement; restoration supplies an uncertainty explanation without sending it. Conflicts and their reapply lineage now survive reload. Unknown versions, unreadable JSON, duplicate object/operation identities or mismatched problem/input records preserve the original bytes and block writes. A compatible application version is needed to recover them. No browser data is deleted to accommodate the migration.

## Reproduced baseline defects and corrections

The unchanged standalone store probe reproduced: (1) an older list response removing a newer completed result; (2) a save overwriting unreadable/future browser draft bytes; and (3) malformed cancellation acknowledgement clearing the pending mutation. All three pass against the migrated source.

A separate actual React/Chromium probe switched the provider from one agent to another while the first agent's list request was held. The original provider displayed the old list under the new agent identity. The same probe passes with scoped ownership. Its baseline is the original Git source, injected only into an isolated bundle; production files were not reverted.

Two temporary Vitest transformations demonstrate failure sensitivity: an unowned native-response cache write reintroduces stale list replacement, and coercing a cancellation response to an applied acknowledgement discards pending intent. Each fails its intended assertion. The transformations do not modify repository source. The earlier candidate mutation that only weakened the transport schema was insufficient because machine context validation still rejected the malformed acknowledgement; the final control crosses that second validation boundary deliberately.

## Verification and limits

On Node 24.21.0, the focused suite passes 18 tests in two files, including the existing real SQLite/Pi/HTTP recovery journey and new identity, compatibility, conflict-reload, storage-failure, malformed-event, cancellation, polling, creation-ABA and native-cleanup checks. The older test's synchronous-dispatch assumption was replaced with an explicit native-entry barrier; its revision/history assertions are unchanged, and the fixture now closes its store scopes explicitly.

Six actual browser journeys (three cases on desktop and mobile) exercise reload of uncertain creation, exact retry identity, conflict reload with explicit reapply, and acknowledged cancellation closing the editor. The fixture uses the real UI with intercepted/synthetic local transports. It builds into isolated `dist/f07-browser` and serves port 4464. Scoped TypeScript, lint and format checks pass. Raw probes, logs, configs and source hashes are preserved under [the F07 evidence directory](evidence/xstate-effect/f04-f08-2026-10-24/f07/original/README.md.txt).

These proofs do not establish external-provider behavior, workerd crash recovery, live production delivery or hosted CI completion. Native Promise cleanup still depends on the foreign operation eventually settling. Browser storage availability is required to persist intent and acknowledgement; unreadable data remains blocked and visible. Repository-wide build, native and hosted publication gates remain parent-owned. The original source-freeze checkpoint preceded the independent review recorded below.

## Independent review follow-up

The fresh bounded review reproduced two additional boundary defects. First, the store's finalizer removed native interruption reasons from a compound failure. It now retains every reason from a native exit containing a defect; pure expected interruption is still excluded when failures are collected. The regression waits for actual native abort, then rejects with checked failure, defect and interruption sentinel 81234 and verifies all three survive scope closure.

Second, malformed version1 records could contradict their own pending/problem facts. Restoration now rejects nonpending uncertainty, nonpending records without a problem, and pending conflict/error records. It preserves their exact bytes and blocks dismissal without any native call. Valid pending records without a problem still restore as uncertainty.

The repaired source passes 22 focused tests plus scoped types/lint. The original six browser journeys are the pre-review UI checkpoint; these two boundary-only corrections have separate unchanged independent probes. Historical evidence remains immutable. Follow-up hashes and raw outputs are in `review-source-manifest.json.txt` in the evidence directory. The independent reviewer reran both unchanged probes successfully and matched all 16 corrected source hashes. Its final bounded review and provenance are preserved in `independent-review-final.md` and `independent-review-final-manifest.json.txt`; no further concrete finding remained.
