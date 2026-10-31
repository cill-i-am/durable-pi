# Workbench frame design evidence

## Scope and source

This slice replaces the workbench tool selector with opened tabs, close/add/select controls, expansion with an explicit return action, and a mobile stacked Open tabs drawer. It preserves the real tool interiors and all existing access/pending-work fences. It adds no Calendar provider, sample production data, or new remote action.

Paper was read before source edits. The approved source is [Pi — Production UI, Conversation First](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-C-1): split Calendar `1AYW-1`, Browser `1B4F-1`, Terminal `1B88-1`, expanded `1BFU-1`, opened-tab interactions `1D6I-1`, and mobile stack `1BS3-1`. The current guide, screenshots of all six frames, JSX for the tab strip and mobile drawer, and computed styles for the frame, active/inactive tabs and drawer rows were inspected. Calendar content was treated as illustration; the implemented menu has Browser, Terminal, Files, Apps, Activity, Checklists, Memory, Code, and Routines.

Executor skills: `executor`, `build-design`, `xstate-effect` (including version and UI references), and `better-ui`. The personal-skills revision was `70d1c37ec652e2b2a9263be9f5899d40d22ef758e3f3156ded50f95227fa2608`. Local `agent-browser` instructions governed isolated browser review. Installed contracts remain Effect `4.0.5`, XState `6.0.0-alpha.68`, and official `@xstate/effect` `1.0.0-alpha.8`.

## Design translation

| Element | Paper | Implementation |
| --- | --- | --- |
| Desktop tab strip | 44px, 8px top/inline inset, neutral underlay | Same values; semantic surface and border tokens |
| Tab | 104 × 36px, 6px top corners, 12/6px inline inset, 13px label | Same values; selected foreground/white surface and inactive muted text |
| Close action | 24px target, 12px 1.5 stroke icon on desktop | Same; 44px touch targets on mobile |
| Frame | 14px corner, white surface, subtle border | Semantic background, border and radius tokens; root owns workspace placement |
| Expansion | Explicit Back to conversation and collapse/close controls | Machine expansion projection; parent keeps conversation mounted while changing layout |
| Mobile tab strip | Active label, close, tab count, + | Same anatomy; a count button opens the tab drawer |
| Open tabs drawer | 24px top corners, 16px inline inset, 60px rows, active muted row | Shared native sheet styling and same row geometry; all 44px actions |
| Tools | Illustrative Calendar/Browser/Terminal/Tasks | Existing nine actual tools; no fake Calendar or task provider |

The reusable local overlay controller is retained because its docked desktop panel, deferred mobile menu actions and close acknowledgements are required by existing behavior. Buttons and tooltips use `@workspace/ui`; overlay presentation uses the same shared semantic tokens. The desktop add menu uses a portal container inside the workbench surface. This fixed an observed native viewport intercepting menu clicks without increasing its z-index. The mobile menu remains in the native nested drawer system.

The focused fixture was rendered at 1440 × 900 and 390 × 844 and compared with the source screenshots. Exact frame control values were also read from rendered computed styles (44px strip, 36px tab, 14px desktop frame corner, 13px label). Its synthetic tool content is deliberately minimal, so the screenshots prove frame anatomy, not the interior redesign or the complete application shell. Mobile sheet height and nested-sheet transforms remain the existing responsive-overlay behavior rather than a fixed-height copy of the illustrative phone frame.

Captured fixture evidence: [desktop](evidence/conversation-first-workbench/desktop.png), [mobile](evidence/conversation-first-workbench/mobile.png), and [stacked Open tabs drawer](evidence/conversation-first-workbench/mobile-open-tabs.png). The rendered mobile drawer has the source 24px top corners and 60px rows.

## Ownership and integration

- `src/app/workbench-tabs.machine.ts` decides opened tab order, duplicate admission, close-neighbour selection, expansion, the tabs/tools surface, locks and observed route changes. `src/app/use-workbench-tabs.ts` starts its official Effect actor in an owned scope, fences navigation against current route/lock facts, and revokes callbacks before cleanup. React holds only the actor projection and DOM bindings.
- The router remains the active-panel authority. Selecting or closing a tab requests navigation; it does not write an alternative active route. Closing the active tab chooses its right neighbour, or its left neighbour at the end; closing the last tab requests the conversation.
- `workbench-presence.machine.ts` retains `retainedPanel` and last search after the matching CLOSED acknowledgement while its public `panel` becomes null. A cold conversation has no retained panel. Existing held-settings behavior and revision fencing remain intact.
- `WorkbenchPanel` accepts optional `renderTool(panel, active)` and `onExpandedChange(expanded)`. The existing `onChange`, `onClosed`, `returnFocus`, `locked`, `overlayOpen`, `overlays`, `recoveryAction`, and children fallback remain supported. `mobileNavigation` is optional; the new root passes null.
- The parent retains the panel once opened per assistant, renders opened tools with stable keys, and supplies route-search projections for each tool. Inactive panels are hidden and inert. The parent passes `active` into tool surfaces so they suppress only their native portals while retaining selected resource identity and form state; hiding an ancestor alone does not hide a DOM portal. Late navigation callbacks check current activity, and pending-work locks are recorded per tool. Closing a tab intentionally releases that tool. Navigating away from the assistant releases its local tab session. This is not browser-reload persistence or a new durable workflow engine.

## Verification

Passed locally:

- `pnpm test tests/workbench-tabs-machine.test.ts tests/workspace-lifetime-machine.test.ts`: 12 tests. Covers unique tab order, router authority, active/inactive/last-tab close, hidden-session retention, locks and overlays, stale surface dismissal, stale-route/revoked callbacks, actual Effect scope cleanup, malformed event rejection, native-close revision fencing, cold start and serialized closed-session restoration.
- `node tests/browser/workbench-tabs-lifecycle.mjs`: real Chromium fixture. Covers all nine menu entries, no mounting of unopened tools, neighbouring-tab behavior, keyboard arrows/Delete, expanded return, unsaved input and exact DOM-node retention across tab selection/hide/reopen/resize, native focus return, lock-disabled commands, mobile stacked Open tabs, adding a tool from that drawer, settings overlay isolation and cleanup. No page errors.
- The focused AxeBuilder audit of `.workbench-header` reports zero violations. The tablist contains only tabs; close buttons remain visually grouped as sibling controls. Pointer close, Enter on a close button, and Delete on a tab all move focus to the selected neighbour; closing the last tab uses native focus return to the conversation control.
- Focused Oxlint and Oxfmt checks pass for implementation, machine, hook and tests.

The full repository typecheck was attempted while other redesign owners were editing. Remaining diagnostics were outside this slice (AgentCollection/AgentSidebar integration in the root and agents exports); full composed checks belong to the root closeout. Earlier workspace-navigation tests exposed two obsolete standalone-list assertions after the shared-sidebar redesign; the root owns that contract update. No CI, merge, deployment, real provider execution or production verification is claimed here.

The standalone browser fixture can be reviewed with `node tests/browser/workbench-tabs-lifecycle.mjs --serve` at `http://127.0.0.1:4319`. It does not authenticate, contact providers, send messages or change application data.
