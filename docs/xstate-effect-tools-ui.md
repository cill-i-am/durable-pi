# Browser and Execution UI lifecycles

**Release status — 25 October 2026:** the refactor is [merged, deployed and verified](xstate-effect-release.md). The checkpoints below retain their original source and test scope; pre-merge delivery status is historical.

F05 migrates Browser and Execution observation, commands and screenshot readiness to the official XState/Effect integration. Backend Browser/Execution records remain authoritative for action identity, outcome and cancellation. This UI owns local HTTP observations and component resources; disposing them does not confirm remote cancellation.

## Ownership and invariants

| Owner | Decisions and resource boundary |
| --- | --- |
| Execution machine | Independent observation and command regions own polling, visible/hidden observation, admission, immutable request retention and completion. A pending command pauses resource refresh; changing the selected run changes only the observation region. Every selection change advances a machine-owned revision, so an earlier command cannot select or publish detail over a later view. |
| Execution host | `execution-owner.ts` provides the existing agent HTTP capability through `nativeOperation`. Each request receives an AbortSignal; interruption joins its actual settlement. Response decoding checks the exact requested run ID. Native cleanup defects retain their complete Cause, including accompanying failures, after actor interruption. |
| Execution React bridge | One Effect scope belongs to each selected agent. It owns the actor, subscription and visibility listener. Unmount/agent replacement detaches notifications, interrupts work and joins scope cleanup. Render identity and the current selected-view callback prevent an old owner publishing into a new component view. Editor code and JSON remain plain form values. |
| Browser machine and host | Browser polling and commands have separate ownership. Ordinary command admission is exclusive. Explicit Close can interrupt a pending observation and obtains a fresh backend generation before sending the Close request. The prior local request remains owned until its native settlement joins. No failed or uncertain browser action is automatically replayed. |
| Screenshot owner | Preview identity includes agent, browser generation and screenshot version. Loaded/failed events from an older image cannot authorize interaction with a current preview. Both interactive controls and the passive preview use this identity. Text input and password visibility remain plain component values. |

The machine is the sole command-admission owner; the old writable `locked`, `lock`, `sequence`, `busy` and `pending` control paths are removed. Button disabled states and pending-navigation notifications project machine state. Backend status and receipt values are displayed without inventing a client-side successful retry or cancellation acknowledgement.

Execution retains the original run ID, code and data after a lost response. An explicit retry sends that same request; polling never retries it. An explicit cancellation uses that original run ID. A backend `interrupted` result is displayed as interrupted and is never automatically repeated. A known running backend result blocks admission of a new run. A different response identity is rejected while the original uncertain request remains available.

No new durable journal, alarm, provider capability or storage migration is introduced. These component-owned lifecycles are ephemeral; the existing backend records continue to support reconnection and saved history.

## Failure-sensitive evidence

The [original mounted React/Chromium Execution probe](evidence/xstate-effect/f04-f08-2026-10-24/f05/original/execution-original-red.log.txt) held a command response, switched the component to another agent, then released the old response. The old hook selected the old run and inserted it into the new agent's history. The unchanged probe now leaves the new agent's selection and history untouched. Network requests are intercepted locally; this is actual React/browser proof, not a provider execution claim.

The [Browser probe](evidence/xstate-effect/f04-f08-2026-10-24/f05/original/browser-original-red.log.txt) separately reproduced readiness carried across agents with the same screenshot version and an old command finalizer refreshing the old agent into the new agent's state. Its unchanged recheck verifies both fences. Focused Effect tests exercise command/refresh separation, hidden polling, exact retry/cancel identity, Close during held native work, stale screenshot callbacks and joined cleanup failures.

An isolated transform removes only Execution's selected-view revision guard. The [regression fails](evidence/xstate-effect/f04-f08-2026-10-24/f05/original/execution-selection-negative.log.txt) on stale detail publication. The production source is unchanged by this negative control. Browser records its own narrow negative controls with the final evidence manifest.

## Verification scope

The [focused evidence record](evidence/xstate-effect/f04-f08-2026-10-24/f05/original/README.md.txt) preserves source/test hashes, raw logs and negative-control provenance. Sixteen focused tests in two files, scoped type/lint checks, the production frontend build and all eight desktop/mobile browser journeys passed. The focused browser gate uses one built frontend and an isolated local server, with controlled API responses. Broad static/unit/native gates, hosted CI, merge and deployment remain separate parent-owned gates. No external browser provider, code runner or model is exercised by these UI proofs.

The [independent Execution review](evidence/xstate-effect/f04-f08-2026-10-24/f05/original/execution-independent-handoff.md.txt) passed additional mounted selection/agent ABA and visibility probes plus actual HTTP-owner joined-cleanup and immutable-retry probes. The parent independently reread both domains and reran all sixteen focused tests; the coordinator's Browser review found no concrete issue in its scoped ownership and identity checks. These reviews are clear within the documented synthetic boundaries.
