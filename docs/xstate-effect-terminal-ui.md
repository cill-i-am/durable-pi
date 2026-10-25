# Terminal frontend ownership

**Release status — 25 October 2026:** the refactor is [merged, deployed and verified](xstate-effect-release.md). The checkpoints below retain their original source and test scope; pre-merge delivery status is historical.

F04 invariants and falsifiable probes, before implementation:

1. The session lease deadline is independent from transport retry. A late renewal cannot revive an expired or ended session. Closing the observer aborts and joins native renewal work; it does not claim remote cancellation or save.
2. One interactive host owns one socket attempt at a time. Readiness alone admits queued input; queue bytes remain bounded. A closed/stale socket cannot write terminal output, flush input or schedule another connection. Disposal joins close before a replacement host acquires the same element.
3. The terminal request machine owns mutation admission and immutable uncertain run/session/transfer identities. Polls never replay a mutation. Responses from a stopped agent/view cannot select or overwrite another view.
4. Export-to-Files retains the original run ID. Leaving during download prevents a later upload; leaving during upload joins its result without claiming it was undone. Explicit retry uses the same export identity.
5. Selection, form drafts and network-setting text remain plain local projections. Existing backend authority, persisted command state and uncertain execution remain the B04 owner's responsibility.

Probes: Effect TestClock expiry versus held renewal; fatal/authorization rejection; socket close/reconnect and old ready/data frames; held native close; simultaneous mutation admission; selection and agent switch during requests; unmount during download/upload; browser desktop/mobile transfer and session journeys. A source-preserving negative control must fail an intended stale-response or cleanup assertion.

## Implementation and recovery

The official `@xstate/effect` actors own lease renewal, socket connection and retry, terminal observation and mutations, the interactive host, and export download/upload. Effect scopes own their native operations and join settlement on teardown. React subscriptions only project the current agent's owner. The interactive host permit is released after socket cleanup, so a second view cannot overlap its producer.

A command captures the view revision at admission. Changing selection advances that revision, including A→B→A navigation; the old response may update history but cannot select or replace the current detail. An uncertain command/session/transfer retains its original ID and payload until an explicit retry or cancellation settles. Polling never dispatches it. Changing agent remounts the pure terminal drafts and resource owners.

Lease expiry is independent of renewal retry. The expiry invocation can stop a held renewal, and a renewal completed at or after the old deadline cannot revive the session. Socket attempts carry a token; old readiness and output are rejected. Input buffering is limited to 65,536 bytes, and native sends use 16,384-byte chunks.

The export saver cancels and joins download on unmount. The existing Files upload API cannot abort an upload already started, so teardown joins it and retains the original export ID; it does not claim that remote acceptance was undone. Joined cleanup preserves defects and all accompanying typed failure, interruption and annotation information.

## Evidence and limits

Focused tests cover expiry, retry timing, native close acknowledgement, uncertain identity, concurrent admission, view changes and A→B→A, and download/upload teardown. The actual addon is exercised against a controlled WebSocket. Desktop/mobile browser journeys exercise the production React components with synthetic HTTP and WebSocket responses: uncertain export retry, closing a held export download, authorization expiry closing a session, and uncertain session opening retry.

A test-only transform removes the view-revision guard and makes the A→B→A regression fail. Independent before/after probes separately reproduced and verified both the selection race and loss of compound interruption reasons during joined cleanup.

These are local synthetic browser/native-adapter proofs, not live sandbox/provider acceptance or backend exactly-once guarantees. Uncertain intent is retained by the mounted owner; a reload uses existing backend history and does not automatically resubmit it. React cleanup requests interruption synchronously, while the retained Effect owner performs the join. If the browser/native API never acknowledges closure, ownership remains occupied; no timeout pretends it was released. The lease helper's `closed` and native addon's `settled` promises expose completion where callers can await it.
