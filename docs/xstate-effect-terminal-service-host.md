# Terminal service host admission

This bounded coverage completion moves Terminal's local admission and cleanup permissions into `service-host.machine.ts`. The existing command, occupancy, execution and interactive-session machines retain their responsibilities and durable representation. There is no storage migration, new retry budget, or change to native command identity.

## Invariants and falsifiable probes

- A shutdown event queued before a permission request prevents new admission. An accepted SQL claim finishing after shutdown is cancelled and released without native dispatch. The actor mailbox test queues CLOSE without awaiting its acknowledgement; the unchanged real-SQLite held-claim test challenges the actual service boundary.
- Concurrent explicit recovery joins one installed fiber. Closing admission does not orphan an already accepted recovery. Its native close/settle and exact occupancy release remain joined before service disposal completes. Existing noncooperative recovery and shutdown tests retain their assertions.
- Failed native close blocks fresh commands and network changes even when no command row exists. Explicit recovery clears that local knowledge only on its accepted recovery transition; the recovering state still prevents competing work until joined completion. The machine test exercises failure, repeated join, failed recovery and later successful recovery.
- Exact command replay retains the existing receipt and may join the original native fiber. No host transition changes a command ID, attempt ID, checkpoint, authority revision or durable occupancy owner.
- Machine payloads are runtime validated. Malformed cleanup observations cannot change admission.

## Supported local host

`terminalLayer` creates the official Effect actor in the service scope and registers Terminal shutdown after it. Shutdown enqueues CLOSE before waiting for the admissions semaphore. Each consequential admission check observes its own Deferred reply from that same mailbox; it does not assume `send` has synchronously changed the snapshot. Later requests therefore cannot overtake shutdown. The actor stays alive while the existing FiberSet is interrupted and joined, allowing cleanup observations to settle before scope closure.

State reporting reads the actor snapshot. The synchronous network permission projection uses `snapshot.can` on the machine's CONFIGURE_NETWORK transition, preserving the existing synchronous API. The active command handle and recovery Fiber remain native capabilities; recovery handle presence no longer grants permission or decides join-versus-start. A captured matching recovery handle supports a join authorized before its finalizer retires it.

Effect continues to own every native close/settle, command fiber, interactive scope and finalizer. This change does not replace those lifetimes with actor stopping. Original compound Causes propagate through the existing joined cleanup paths; the admission fence preserves an observed failure Cause after cancelling an undispatched claim.

## Evidence boundary

The three original Terminal service/claim/coordination suites are behavioral acceptance. `tests/terminal-service-host.test.ts` adds direct official-host mailbox, recovery, permission and malformed-event probes. A source-preserving negative control removes the closed-state permission guard; the queued shutdown test must fail. No live Sandbox/provider effects or frontend changes are included.

Two legacy fixtures now wait for the held native close to enter before their original busy, interrupted-row, admission-rejection and network-rejection assertions. Their `recover()` wrapper returns `ManagedRuntime.runPromise`; it never promised completion of recovery SQL in the caller's JavaScript stack. The asynchronous actor permission acknowledgement makes that distinction observable. Cleanup remains held through every safety assertion. An additional concurrent recovery/command test proves the command cannot bypass the accepted recovery; no custom scheduler or synchronous second reducer was added.

Resource availability and open-host admission are distinct checks. A call already waiting inside the repository read retains the previous behavior: it can claim its original intent and then observe closed admission, writing the exact cancelled receipt without dispatch. Rechecking closed admission in the resources-only guard would erase that accepted-but-undispatched receipt; the unchanged held-SQL test detects this difference.

Fresh review found that fatal close/settle Causes could bypass the earlier typed-error observation when no command rows existed. The service now reports every failed joined native cleanup exit to the host machine, including interruption and defects, before recording release. The failure itself still propagates with every original Cause reason. A real SQLite empty-ledger regression verifies blocked network/command admission and explicit successful recovery.
