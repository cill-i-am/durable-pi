# Apps frontend lifecycle

**Release status — 25 October 2026:** the refactor is [merged, deployed and verified](xstate-effect-release.md). The checkpoints below retain their original source and test scope; pre-merge delivery status is historical.

## Invariants and probes before implementation

1. One mounted agent/app owner admits a mutation at a time. Explicit retry reuses its immutable path, payload and operation ID; refresh never resubmits. An uncertain cancellation retains that identity until a confirmed result, including a required reload after an already-applied cancellation.
2. Observation, mutation and iframe resource ownership are independent. A stale read cannot overwrite a mutation or another agent/app. Teardown aborts and joins native work; it does not claim a remote write was rolled back.
3. A sandbox frame accepts messages only from its exact content window, opaque origin and current random channel. It also checks the current published revision and disabled state at action admission. Replacing a frame or leaving while an action is held cannot start a follow-up render from the old owner.
4. Form drafts and version selection remain plain projections. A completion can clear only the draft submitted by that attempt; newer edits survive. Agent/app/version identity isolates drafts and frame resources.
5. Existing backend app/revision/operation authorities and sandbox CSP remain unchanged; no second frontend persistence journal or provider protocol is introduced.

Source characterization: `useApp` fences reads but mutation completion writes React state without an agent/app fence; its `finally` starts a refresh after unmount. `WebCanvas` captures `load` in a promise continuation and calls it after a held action succeeds, even after effect cleanup. It also retains old preview state while identity changes. `AppForm` clears its draft after an awaited success without identifying the submitted draft. These are the race boundaries to falsify.

Probes: held mutation followed by owner replacement; retry and cancellation with the exact original operation; refresh racing a mutation; stopped native cleanup with a compound Cause; stale iframe channel/window and disabled/revision changes; held action then frame replacement without follow-up rendering; draft edits made while an acknowledgement is held. Browser journeys exercise production components under synthetic HTTP and sandbox messages. A source-preserving negative control must fail the old-owner/frame assertion.

## Owners and compatibility

`app-ui.machine.ts` admits one mutation and its reconciliation read, while retaining the original uncertain request. Ordinary observation does not clear mutation uncertainty. An already-applied cancellation keeps the original operation until its reload succeeds. `app-list.machine.ts` owns visible polling. Component subscriptions project only the matching agent/app owner and close their scope on replacement.

`web-canvas.machine.ts` owns render, ready and action progression; its parent invocation owns the message listener. The platform adapter verifies the current content window, opaque origin and channel, then checks current disabled/revision authority again immediately before invoking the action. The HTML frame is keyed to agent/app/version/block identity. Its CSP, sandbox attributes and pure HTML/CSS generator remain unchanged. The embedded browser bridge only relays trusted input and projects the owning actor's enabled message; every consequential action is admitted by the parent actor and existing Apps backend.

`app-form.machine.ts` binds an acknowledgement to the submitted edit revision. New edits, including A→B→A, survive an old success. Draft values and version choice remain local presentation data. App, version and inline references keep their existing IDs; identity changes remount only the corresponding view owner. No app schema, operation receipts, API route or backend execution owner changed.

Effect scopes retain native operations until actual settlement and preserve complete late compound Causes. A stopped UI cannot begin its reconciliation read or a follow-up frame render. Aborting a request does not confirm remote cancellation; the existing backend ledger remains authoritative. Local uncertain intent survives within its mounted owner, as before; a reload does not automatically resubmit it or create a new durable UI journal.

## Evidence

Before production edits, actual mounted `useApp`, `WebCanvas` and `AppCanvas` probes reproduced all three defects: a second old-agent read after replacement, a second render after removing the frame, and an acknowledgement erasing a newer form draft. The same safety assertions pass after migration on desktop and mobile. The tests also check immutable operation retry, wrong frame sources/origins/channels, and disabled or changed-revision admission.

Focused Effect tests hold native cleanup barriers, drive polling with TestClock, verify cancellation reload failure retains the original operation, reject simultaneous commands, and preserve compound native failure reasons. A test-only transform that removes the form edit-revision guard fails the A→B→A assertion. All browser responses and native work are synthetic local fixtures; this proves frontend ownership and recovery behavior, not live app/provider acceptance or external exactly-once execution.

Fresh review challenged actual HTTP ownership with held native responses. The shared HTTP client now joins unread response cancellation (including401), preserves structured error-body Causes, and combines the original API error with complete failed cancellation. Ordinary malformed JSON still uses the prior fallback and status/code mapping. The shared native join adapter also retains a late raw Fail plus annotated Interrupt even when no Die originally exists; AbortError and pure interruption controls remain quiet. Apps applies preserveFatal before observing direct Effect failures. No feature-specific Promise join adapter remains.
