# Workspace lifecycle migration (B10)

## Invariants written before implementation

- The ledger retains file/content identities and capacity reservations. A repeated upload compares immutable input before any external work; an accepted reservation may finish after archival. New reservations and explicit extraction retries require current write authority.
- Official Effect-backed machines decide upload reservation and processing stages, durable document/video claim, completion, failure, bounded recovery and explicit retry. Storage reconstructs versioned domain data synchronously; it does not run an actor inside a transaction.
- Warm facade reconstruction never claims a running job. Effect scopes own every local invocation and join native cleanup before releasing the shared ledger's occupancy. Shutdown retains late compound Causes.
- Only actual runtime activation calls restoration. A running deterministic document/video attempt becomes pending after interruption, retaining the three-attempt budget. A new attempt receives a fresh token; retry budget reset cannot let an old completion through.
- R2 publication is content addressed. Ready metadata includes the exact output hash; late old writes may leave unreferenced objects but cannot change a newer published result. Legacy ready assets remain readable at their existing keys.
- Discovery is retained before durable processing intent, and its deadline is checked inside the original acceptance transaction. No post-commit-only wake claim is sufficient.
- Image/audio preparation remains request-owned. Cancellation joins work, preserves the reservation, and cannot publish a late result. Explicit matching upload replay authorizes retry; no external exactly-once claim follows.

## Falsifiable probes

1. Hold an old R2 extraction write; a second warm facade cannot claim it. Explicit activation recovery plus a new attempt may finish, but releasing the old write must not alter served bytes or metadata.
2. Hold cleanup during cancellation; a replacement upload/preparation cannot enter until cleanup is joined. A late checked failure plus defect survives shutdown.
3. Expire or omit discovery before acceptance; transaction admits no processing job. Failure after intent but before dispatch is discoverable by the retained runner.
4. Restore legacy uploading/ready and pending/running/ready/empty/failed records without changing identities, hashes or retry times; future versions fail closed.
5. Exhaust three automatic attempts; only explicit authorized retry resets the budget. Duplicate/stale attempt events never publish.
6. Negative controls remove immutable publication, exact attempt fencing or discovery validation and must fail the corresponding regression.

Implementation and measured evidence will be recorded after the probes run. Synthetic R2 and processors are not production-provider evidence.

## Implemented representation and ownership

`reservation.machine.ts` owns reserved upload claims and exact completion. `upload.machine.ts` chooses replay, original write, image preview/audio transcription, retained discovery and publication. `preparation.machine.ts` owns pending/running/ready/empty/failed progression, the three-attempt budget, retry authority, recovery and expiry. `extraction.machine.ts` chooses acquisition, decode, immutable publication, fenced commit and typed recovery. All local invocations run under `createEffectActor` in an explicitly closed Effect scope.

The authoritative records remain the existing `workspace_files`, `workspace_extractions` and `workspace_video_preparations` rows. Additive migration 18 adds `lifecycle_version`, `attempt_id`, and job `artifact_hash` / `recovery_deadline`; no second writable machine snapshot exists. Version 0 conversion validates and writes version 1 inside the ledger transaction, preserving identifiers, original hashes, dates, content, attempt count and video retry time. Future versions fail as defects. Legacy ready artifacts retain their existing original-hash lookup until another accepted attempt publishes a content hash. The workflow uses the canonical pinned XState alpha.68 / Effect integration alpha.8 and application schema/workflow version 1; it adds no Pi execution/version contract.

Upload occupancy is shared by ledger identity and file ID. Idle entries are removed only after every waiting/current caller leaves. Preparation occupancy is shared by ledger identity. A second warm facade cannot claim a running row or enter processing before the first scope joins. Matching accepted uploads may still finish after archive. Exact ready replay and conflicting replay compare immutable input before invoking discovery; legacy ready PDF promotion still validates its pre-armed discovery deadline inside the original transaction.

Each document/video attempt has a fresh token, including after explicit retry resets its counter. Publication writes output SHA-256 keys and commits their exact hashes with metadata only for the matching token and attempt. A late old native write may leave an orphan object. It cannot replace newer referenced bytes. Ready metadata and image/audio alternatives retain the existing file identity. Object-store orphan reclamation is outside this change.

Pending recovery has a ten-minute deadline per accepted phase. Admission, explicit retry, claim and a returned pending phase set it; status reads never renew it. Expired pending jobs become actionable failed records transactionally. Unclaimed runner exhaustion expires only overdue rows and returns the earliest remaining pending deadline, preserving fresh jobs. Exact exhaustion uses the current runner callback and the attempt token/count inside the same original SQL transaction.

A positively recorded failed attempt whose native scope has joined may also become failed on an overdue status read. The shared ownership map records that exact token at claim and records joined only after scope closure; missing entries never prove release. Live/unknown running rows cannot expire through reads. Joined entries retire when their state retires or a new claim for the same file begins; successful attempts remove their entries. Actual cold activation alone calls `restorePreparation`: running jobs resume their existing bounded budget before the deadline, or become failed after it. This is a deliberate deterministic reprocessing policy, not external exactly-once execution.

If terminal persistence fails, the runner must retain the exact claim while its bounded cleanup retries remain. After those are exhausted, later status can expose expiry for positively joined attempts; actual activation can expose expiry when process-local ownership evidence is gone. These observations require storage to become available. Neither local cancellation nor a failed write proves remote provider cancellation.

## Local evidence

The direct Workspace suites cover real SQLite and the production R2 adapter against synthetic objects/processors. Added probes exercise warm facade ownership, document/video held-put publication across explicit activation recovery, retry-counter ABA fencing, joined compound failure, discovery expiry inside the transaction, missing discovery, compatible/incompatible conversion and conversion rollback, ready replay, pending expiry after a rejected terminal write, and held live work versus positively joined failed work.

Five temporary mutation controls were run and reverted:

- Replacing content-addressed publication with the original asset hash makes both document and video serve the older held result.
- Removing the admission deadline check accepts expired processing intent.
- Removing the durable machine's token guard accepts a stale completion.
- Removing pending expiry leaves the exhausted unclaimed pump pending past its deadline.
- Removing positive joined ownership proof expires a still-held live native attempt.

Native retained-discovery restart/negative-control evidence and the bounded Lifecycle runner belong to the parent integration lane. These local tests do not claim real R2/provider execution, production deployment, hosted CI or process-kill recovery.

The final domain verification ran 11 direct Workspace/PDF/video test files with 82 passing tests, including 16 new lifecycle probes. Owned-path Oxlint and formatting checks passed. Scoped type checking found no Workspace-domain diagnostics; while this record was written, parent worker composition still referenced its not-yet-written runner module, so an integrated typecheck remains a parent gate. The audio compound-failure regression was first observed red: `AudioUnreadable` plus cleanup `Die` collapsed to an ordinary rejection. Placing `preserveFatal` before typed audio recovery makes the regression green and retains the actual cleanup defect. Independent domain review, including ready replay, version conversion, joined ownership and the audio correction, found no remaining concrete issue in these paths.

## Runner integration and final publication evidence

The domain checkpoint above is followed by the integrated `WorkspaceRunner`, which preserves legacy `workspace-extraction:pump` and adds retained discovery at `workspace-extraction:recovery`. Fresh processing prearms a 60-second lease; an early empty scan retains it. Cold activation reconciles existing state; ordinary reads do not take over live ownership. The host uses the bounded extraction cycle and removes the old unbounded failure runner.

The [publication manifest](evidence/xstate-effect/b10-publication-manifest.json) identifies the final source above inherited `c5e3a02`, byte-exact artifacts, and the matching earlier native checkpoint inputs. [Static checks](evidence/xstate-effect/b10-composed-static.log.txt), [2,979 tests in 264 files](evidence/xstate-effect/b10-composed-unit.log.txt), and [website/routing/all Worker builds](evidence/xstate-effect/b10-composed-build.log.txt) passed. The [final combined native run](evidence/xstate-effect/b10-composed-native.log.txt) proves held resource ownership, exactly three automatic failures, the historical payloadless job identity, real retained-alarm recovery after SIGKILL without an object request, explicit retry, and a second restart with unchanged completed bytes and metadata. Its [observations](evidence/xstate-effect/b10-composed-positive-evidence.json.txt) and [Workerd output](evidence/xstate-effect/b10-composed-positive-workerd.log.txt) are preserved.

The [negative control](evidence/xstate-effect/b10-native-negative.log.txt) removes retained discovery and fails because processing stays pending. Earlier [72-case browser/passkey/upgrade](evidence/xstate-effect/b10-browser-checkpoint.log.txt) and [WhatsApp attachment](evidence/xstate-effect/b10-whatsapp-checkpoint.log.txt) runs remain scoped checkpoints before stack composition. Store-only attachment fixtures use a short explicit test lease and manually resume work; they do not prove alarm delivery. The native test uses a durable SQLite bucket through the production asset adapter and synthetic extractors, not hosted R2. Ten-minute final cleanup expiry is deterministic unit coverage. Exact-commit full hosted CI remains required; this layer does not merge or deploy.
