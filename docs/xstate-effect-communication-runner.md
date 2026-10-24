# Communication runner lifetime

Invariants for this slice:

- The existing mailbox recovery record, retired epoch, discovery lease, exact control receipt and transactional revision fences remain durable authority. Lifecycle owns the three attempts and physical alarm.
- One scoped machine owns activation, callback identity/phase, wake coalescing, scheduling, pending failure-publication identity and closed admission. A queued old restoration request remains attached to its observed generation.
- A running callback cannot overlap itself or be prematurely exhausted. A successful storage acknowledgement clears only the exact pending failure intent it wrote; a newer failure or explicit recovery retains its identity.
- New admission may replace discovery without consuming an older run's receipt. An exhausted or retired pump token never regains dispatch authority through wake, cold restoration or a replaced recovery prearm.
- Close refuses new work before storage access and joins accepted storage, restoration, callbacks and failure publication. The actual mailbox runtime and actor SQL remain alive until those operations settle. Effect-to-Promise boundaries retain complete failure reasons.

`communication/runner.machine.ts` now owns activation generations, exact callback identity and running/failed/exhausting phases for both pump and discovery jobs, receipts, the original discovery token, queued scheduling, pending failure-publication identity and closed admission. The adapter retains native actor/scope/Promise handles. The former dispatch Map, restoration flags and completed-failure field are removed.

The original adapter fails two added tests: an overlapping call using the exact same SDK object reaches the pump twice, and premature exhaustion consumes a receipt while native work is still held. The machine admits only one running callback and one exact failed callback into exhaustion. A separate delayed-publication control reproduces an old failure reappearing after explicit recovery; the persistence transaction now also checks the retained retired epoch. Late acknowledgements clear only their own pending intent, and a failed new publication remains available for the next exact retry.

The native callback binding discarded checked/defect/interruption reasons at Effect.runPromise. Both the adapter executor and actual mailbox callback now carry complete Exits through that boundary. Reverting the adapter bridge fails four strengthened checked-Effect cases; the actual PersonalAgent probe fails for the original Communication callback. A held native callback also reproduces early runtime/SQLite closure. PersonalAgent now joins Communication alongside provider shutdown before disposing either its mailbox runtime or actor storage.

All 66 focused cases, static checks, all 3,776 unit tests in 330 files, website/route checks and seven Worker builds pass. The full native PersonalAgent/Communication suite passes, including three complete-failure callback bindings and five held-runner joins. Native Communication control also passes the surviving exhausted SDK row, exact explicit recovery, held submit/abort ownership, and two SIGKILL recovery checks. Discovery waits through the actual sixty-second lease without object requests; the exact envelope/inbox receipt, consumed continuation and completed task/delivery rows survive restart without another submission or model call. Providers remain synthetic.

[Raw evidence and final source hashes](evidence/xstate-effect/communication-runner-2026-10-24/README.md) retain the before/after controls and final checks. Hosted CI remains a publication gate. Workspace and the retained runner boundary audit remain open. No merge, deployment or live-provider delivery is claimed.
