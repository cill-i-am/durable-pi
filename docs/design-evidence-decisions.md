# Decision dock implementation evidence

Status: implemented and locally verified on 31 October 2026. This record does not establish CI, merge, deployment, or production verification.

## Design before code

Read the existing approved designs in [Pi — Production UI, Conversation First](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-C-1) before editing source. Read the current Paper guide, frame trees, JSX, computed styles and token values, then inspected screenshots of:

- `1DHK-1`: Decisions · Dock · Chosen flow.
- `1E23-0`: Decisions · Dock states.
- `1FDX-0`: Decisions · After checking.
- `1BJN-1`: Decision queue.
- `1BS3-1`: Mobile · Conversation to stacked drawers.

The canonical compact dock, expandable desktop queue, phone queue drawer and phone detail sheet were retained. No Paper mutations were needed. Paper-only examples are design references and do not establish calendar or multiplayer capabilities.

Executor catalogue and skills read: `executor`; `build-design`; `xstate-effect` with version, React, actor ownership and testing references; `design-exploration-swarm-paper` for the retained Jakub component-state and less-is-more rationale. Shared skills revision: `70d1c37ec652e2b2a9263be9f5899d40d22ef758e3f3156ded50f95227fa2608`. Native Paper tools were used because the connected Executor catalogue had no suitable Paper operation. The local `agent-browser` core guide was read for visual and accessibility checks.

## Design mapping

| Element | Paper values | Implementation |
| --- | --- | --- |
| Dock | 720 px reference area, 12 px padding, 10 px radius, 1 px border | Fluid parent width; semantic `--spacing`, `--radius-md`, `--border`, `--card` tokens |
| Type | Geist; 14 px medium title, 13 px body, 12 px scope/count | Existing Geist and `--text-base`, `--text-sm`, `--text-xs` tokens |
| Actions | 36 px desktop, 44 px phone | Shared `@workspace/ui` Button behavior; 44 px phone targets retained |
| Queue | Bounded rows beneath active request; phone bottom drawer | Scrollable desktop queue; shared phone Sheet with bounded queue |
| Detail | Rounded phone sheet with explicit close | Shared Sheet, full wrapped inputs, explicit close, focus management and Escape support |
| Receipts | Compact read-only outcome in conversation | `ApprovalCard` without any command owner, native disclosure for exact inputs |

The existing shared Button and Sheet visual treatment is retained. The dock uses a flat border instead of introducing a separate one-off shadow; the approved 3% dock shadow has no exact semantic token. Screenshot comparison found consistent 12 px inset, 10 px dock radius, readable hierarchy, aligned controls, bounded sheets, and no horizontal overflow at 320 px. The queue and detail retain conversation context behind the shared phone overlay.

Domain adaptation: current approvals cover arbitrary tools. A calendar example cannot safely summarize an arbitrary request's complete effects. The compact primary action is therefore **Review action**, and approval controls appear only with the complete tool identifier and action inputs visible. No calendar data, provider result or person attribution is fabricated.

## Wiring contract and lifecycle

`DecisionDock` is exported from `@/features/access` with:

```ts
{
  agentId: string
  agentName: string
  access: ChatState["access"]
  disabled: boolean
  onRefresh: () => void
}
```

The conversation owner renders it above the composer and omits pending `ApprovalCard` instances from the transcript. `ApprovalCard` remains a read-only receipt for durable accepted/running/completed/declined/cancelled/expired/interrupted states. Approval acceptance is described as waiting to run; only durable `done` is called completed.

The local `decision-dock.machine.ts` owns compact/queue/review transitions, selection, local deferral, acknowledgement presentation and the busy/uncertain selection lock. `createEffectActor` is started in the mounted conversation's explicitly owned Effect scope; unmount closes its subscription and actor scope. No local presentation state is persisted. Remount starts from current Access facts.

`Later` adds only a local presentation key to the deferred set. It sends no denial or policy change, keeps the awaiting count unchanged, and allows explicit selection from the queue. Every key includes approval identity, turn, tool, complete inputs, creation/expiry and revision. Changed inputs or a new round invalidate an older review or deferral. Local acknowledgements hide only that exact round while the canonical snapshot catches up.

Exactly one active request owns `useApproval`; detailed and compact controls share it. No transcript receipt submits commands. The existing approval machine, request adapter and backend are unchanged. `useApproval` adds read-only `ready` and `uncertain` projections. Consequential controls stay disabled until the current approval owner exists, and submission checks admission before locking the local queue. Expected approval revision, current policy revision, disabled authority, immutable request identity, and existing interruption behavior remain authoritative. Busy or uncertain requests lock deferral and queue selection to retain the request owner. Scope closure interrupts the native request and joins cleanup; interruption makes no remote rollback claim.

**Check status** invokes only `onRefresh`. Re-reading unchanged pending facts retains uncertainty and offers no alternative decision or automatic replay. A reconciled durable terminal status advances the dock. The callback is synchronous and has no acknowledgement contract, so this component does not invent a completed checking state.

## Checks and artifacts

- `npm_config_manage_package_manager_versions=false pnpm exec vitest run tests/approval-readiness.test.tsx tests/decision-dock.test.ts tests/approval-card.test.tsx tests/approval-decision.test.ts tests/access-connections-ui.test.ts`: 33 tests passed, including a deterministic initial-render readiness check before effects acquire the approval actor.
- `npm_config_manage_package_manager_versions=false node tests/browser/decision-dock-lifecycle.mjs`: passed. Exercises real components and request adapter against an isolated local fixture: allow, deny, future permission, complete scope, current revisions, local deferral, selection, changed inputs/rounds, uncertain status reads without replay, held request interruption on unmount, disabled controls, keyboard focus confinement and return on Escape, 390 px bottom sheets, and 320 px reflow. No real provider was contacted.
- Scoped Oxlint and Oxfmt checks passed for the changed access files and focused tests.
- Shared `pnpm typecheck` passed after the implementation; final repository-wide gates remain the delivery owner's responsibility as other surfaces are being edited concurrently.

Browser screenshots are generated under `test-results/decision-dock/`: `desktop.png` (1440 px viewport / 720 px dock), `mobile.png`, `mobile-detail.png`, `mobile-queue.png` (390 px) and `320.png`. Final screenshots were visually compared with the Paper dock and phone anatomy. The reproducible fixture may be opened locally with `node tests/browser/decision-dock-lifecycle.mjs --serve-only` on port 4409.

## Unwired design proposals

- Provider-specific verified failure, confirmed absence, retry/new-attempt creation and provider execution receipts: no supporting API was added.
- Calendar/workbench-specific recovery controls and a user named as approver: current Access contracts do not carry those facts.
- A confirmed checking/progress state beyond invoking the existing conversation refresh: the callback does not report completion.
- Persistent cross-client deferral: `Later` intentionally remains local presentation state.

No backend API, durable persistence engine, new connection, production mutation, commit or deployment was introduced by this slice.
