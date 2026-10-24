# F09 family and model access ownership

Family reads, membership changes, invitation recovery, model sign-in, and explicit catalog refresh now run through scoped actors built with the official `@xstate/effect` integration. Better Auth retains sessions, verification and membership authority; the model-account backend retains its credential attempt and exchange authority. No new backend engine, credential format, auth API, or durable receipt is introduced.

The old browser race is preserved in `tests/browser/family-ownership.spec.ts`: overlapping focus reads allowed an older successful family snapshot to restore the workspace after a newer 403. The old source fails that assertion. The family-read machine serializes reads, coalesces requests arriving during a read, and makes access-ended terminal for the current workspace owner. It polls every 30 seconds. Each read has a ten-second local timeout, but shutdown and replacement still join the actual native Promise and body cleanup; an uncooperative native operation keeps ownership until it settles.

| Owner | Progression and bounds |
| --- | --- |
| Family access | Loading, ready, failed, access-ended and signing-out. One active read, at most one queued read. No automatic sign-out. |
| Family mutations | Idle, changing and refreshing. One admitted command, no automatic mutation retry. An accepted mutation remains accepted when the subsequent family refresh fails. Current owner identity is checked at dispatch and before accepting late output. |
| Model sign-in | Restoring, idle, starting, waiting, exchanging, reconciling, expired, cancelling, cancelled and connected. The backend expiry controls the waiting deadline. A failed exchange performs one status read; only the same still-pending attempt can accept another explicit return address. It never automatically replays an exchange. |
| Catalog check | Idle/checking, with a separate accepted-connection fact. A new connection during a check queues one follow-up check. TanStack Query owns the catalog itself. |
| Invitation | Verification, session refresh, invitation lookup, preview, bounded preview retry, ready, native command, joined acceptance, failure and welcome. The preview alone retries once after 250 ms, with a ten-second signal deadline per read. Verification, signup, sign-in, resend, sign-out and acceptance never automatically replay. |

Changing an invitation immediately revokes the previous operation's signal and records the latest generation. The machine waits for its actual native settlement before opening the replacement. Late acceptance cannot clear a newer URL. The latest SDK account is checked again before acceptance dispatch, after its response, and after session refresh before navigation. Native SDK work without a cancellation API still remains owned and joined.

The synchronous blank popup is a browser resource acquired in the click handler, preserving popup-policy activation. Its owner closes it on failure/revocation and checks the current family authority before navigation. Once successfully navigated it belongs to the user. The return field focuses when waiting begins. A cancellable two-frame reconciliation runs after the mobile drawer's own focus restoration and only moves focus from the body or containing dialog; it never overrides another selected control, and checks the latest waiting state before acting. Return addresses and passwords are Redacted values inside ephemeral actors and are cleared from input fields when submitted; no credential or token is written to browser storage.

A new tab-local `pi:family-invitation:v1` record stores only `{ version: 1, invitation }`, so the actual auth SDK's `/two-factor?returnTo=%2Fjoin` redirect does not lose the invitation. Verification tokens are removed from the URL before dispatch and are never stored. The record is removed only after confirmed acceptance of that exact invitation. Unknown-version, corrupt and inaccessible storage is left untouched; the active URL continues to supply the invitation when available. No existing browser format or key changes.

`makeFamilyRequests` retains structured native defect/interruption Causes through actor shutdown. Scope closure first joins the actor's native work, then reports the retained complete Cause; ordinary checked failures remain user-facing recovery states. Component cleanup revokes immediately and interrupts its owning Effect fiber, whose finalizers join the actual resources. Focus/hash listeners and subscriptions belong to those scopes.

Independent input values (name, email, password text), dialog selection/open state, SDK session/query projections, and URL parsing remain ordinary data. Machine snapshots are ephemeral and are not restored as a second persistence authority.

## Evidence and limits

Focused tests cover serialized access denial, duplicate commands, accepted acknowledgements with failed refresh, current-role dispatch, late revocation, expired sign-in and its clock deadline, uncertain exchange without replay, blank-popup cleanup, joined native compound Cause, preview retry exhaustion, invitation replacement during held acceptance, current-account changes during refresh, malformed commands, and compatible/unsupported tab data. Existing invitation evaluation tests remain in the focused gate.

Real browser journeys use the actual application and Better Auth client with isolated synthetic HTTP responses. They cover the unchanged family screens, return-address privacy and recovery, the SDK challenge redirect, late invitation acceptance and late model exchange. The preserved old-source access-denial race provides the failure-sensitive control. These checks do not claim live email delivery, a real ChatGPT credential exchange, production authentication, or deployment.
