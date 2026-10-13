# Five-pass interface audit

## Goal

Audit every implemented screen, entry point and interaction in Durable Pi five times. Apply concrete findings, remove redundant copy and actions, preserve durable execution and access guarantees, and deliver through review, CI and production verification. All five passes and the subsequent recorded-activity treatment are delivered; release evidence and verification limits are recorded below and in BUILD.md.

## Sources and boundaries

- [Jakub Krehel's skills](https://github.com/jakubkrehel/skills/tree/c0588bb6d654eb725046f0bf9deec338c34891ab), MIT, installed in Codex rather than vendored into this repository. All 13 skills installed; the six `better-*` domain reviews and `better-interface` govern this audit.
- Existing Paper file, semantic light/dark tokens, shadcn/Base UI primitives, TanStack Start routes, `UI_FIDELITY.md`, `docs/navigation.md` and `docs/responsive-overlays.md`.
- UI mutations are exercised with synthetic local data. Hosted checks use isolated resources or read-only screens. No real account security, external actions, private agent content or credentials are changed for an audit.
- Plans, receipts, permissions, cancellation and object revisions keep their current backend owners. Removing explanatory copy must not remove actionable blockers or consequences.

## Passes

Each pass revisits the complete inventory below in all six review domains. The focus column determines deeper interaction checks, not an exclusion of other domains. Record observed findings, fixes and limitations; a pass is not complete merely because tests pass.

| Pass | Focus | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Entry points, routes, names, keyboard access and recovery paths | Complete | Reviewed the 17 surfaces below; corrected link roles, workbench landmarks, page titles, skip navigation and focus return. |
| 2 | Complete task journeys, pending/error states, destructive actions and duplicates | Complete | Synthetic checklist edits, code execution, routine creation, app/terminal uncertainty and cancellation; source review of security, permissions and recovery. |
| 3 | Copy, typography, semantic colours and control hierarchy | Complete | Removed repeated copy and the competing checklist builder. Checked light/dark tokens and rendered control backgrounds; shared copy feedback. |
| 4 | Mobile, nested overlays, narrow widths, zoom and reduced motion | Complete | 320, 390 and 640 CSS-pixel checks, nested menus, keyboard containment and reduced-motion emulation. Native browser zoom and real-device checks remain unverified. |
| 5 | Post-fix regression walk, checks, review and hosted release | Complete | Rechecked error/retry, inline and workbench app guards, terminal cancellation, palette keyboard navigation, archive confirmation and file focus. PR #81–#83 checks/deployment passed. Hosted acceptance exposed a saved-execution URL blocker; corrected it and verified the real receipt journey below. |

## Screen and interaction inventory

| Surface | Entry points and interactions to inspect |
| --- | --- |
| Sign in / setup | Email, password visibility, sign in, setup key, first-time switch, errors, forgot password |
| Password recovery | Request email, resend/back, reset token validation, password save, success/expired states |
| Two-factor challenge | Code input, recovery code switch, trust device, submit, error and return to sign in |
| Agents | Search, active/archived lists, new/edit, selection, context menu, archive confirmation, restore, missing agent |
| Workspace navigation | Account and top menus, command palette, shortcuts, sidebar, mobile navigation, workbench open/close, deep links and browser history |
| Conversation | Empty, running, thinking, tool disclosure, attachments, copy answer/code, model/reasoning/delivery controls, send/steer/queue, stop/retry, approval and recovery |
| Settings | General, appearance, sounds toggle/test, delivery preference, model defaults, edit agent, access, connections, skills, security and close/back |
| Account security | Enable/verify/disable 2FA, recovery codes, current/other sessions, revoke session(s), cancellation and errors |
| Browser | URL entry, navigation/read, screenshot, links, owner control, input/click/key/scroll, refresh/close, internet policy and errors |
| Terminal | Command execution/history/output, interactive session, stop/reconnect, upload/download workspace files, network policy and recovery |
| Code execution | Run, saved executions, source/output, failure and retry |
| Files | Upload/drop, status, search/list/select, previews/tabs, attach/remove context, trash/restore, pagination and unavailable resource |
| Apps | List/select, inline/workbench rendering, checklists/forms, version selection, web app actions, archive/restore and unavailable resource |
| Working objects | Create/select, task edit/status/due date/notes, save/conflict/retry, history, origin link, archive/restore |
| Memory | Search/retrieval, notes/provenance, original/summary tree, corrections and recovery |
| Routines | Create/edit, schedule, pause/resume, run history, webhook/secret lifecycle, archive and errors |
| Activity | Scope/filter, timeline/detail, plans/evidence, delegated work, inference usage, blockers, retry/reconcile/cancel and pagination |

## Scope and coverage

React 19, TanStack Start/Router, TanStack AI conversation rendering, shadcn with Base UI, existing responsive bottom drawers, Effect contracts and semantic CSS tokens. No `AGENTS.md` was found in the checkout. Each pass revisited the inventory in the six domains; browser checks concentrated on the pass focus and the changed behavior. This is a source-complete review with representative runtime journeys, not a claim that every external effect or security action was performed five times.

| Domain | Evidence inspected | Result |
| --- | --- | --- |
| Accessibility | Root/routes, links and landmarks, fields, hidden pickers, overlay focus, file rename, menu and palette keyboard paths, OTP, tab names and pending controls | Link, landmark, focus, boundary and reflow findings fixed |
| Colors | Light/dark semantic declarations, rendered input/select backgrounds and borders, semantic status colors | Stronger input boundaries; decorative separators unchanged; 12 contrast assertions |
| Layout | Chat, settings, all workbench interiors, collections, forms, nested drawers, 320/390/640 CSS-pixel views | Wrapped clipped Memory tabs; larger mobile buttons; removed obsolete welcome layout |
| Typography | Shared body, mobile editable controls, code/text previews, headings and truncated resource rows | Relative body size, unitless line height, 16px mobile fields and full history labels |
| UI | Click handlers, loading/error/pending transitions, retries, native cancellation, drafts, copy controls, destructive confirmation and checklist state ownership | Pending navigation guards, usable retry states, one checklist creation flow |
| Writing | Auth, settings, conversation, all workbenches, empty/recovery states and consequences | Repeated ownership/marketing copy removed; necessary constraints and blockers retained |

## Findings

Locations name the owning source. All listed changes are implemented; severity describes the original problem, not a remaining blocker.

| Severity | Domain | Location | Before | After | Why |
| --- | --- | --- | --- | --- | --- |
| HIGH | Accessibility | `src/app/workspace-settings.tsx`, resource rows, exports and auth links | Base UI buttons rendered links with button semantics; workbench used a tab panel without corresponding tabs | Native TanStack links/anchors with `buttonVariants`; labelled workbench section and URL navigation | Navigation keeps link behavior and accessible roles; no orphaned tab relationship |
| HIGH | Accessibility | `src/routes/__root.tsx:60`, `src/features/files/files-panel.tsx:338`, feature forms | No skip link; rename exit lost its useful focus target; newly opened editors did not consistently focus a field | Skip-to-content target; rename autofocus and return to Options; Browser/Terminal policy-editor return focus; first-field autofocus in explicit editors | Keyboard users can reach content and continue after editing |
| HIGH | Colors | `src/styles.css:103`, `src/components/ui/input.tsx`, InputGroup/Select/Checkbox | Pale input boundary failed 3:1; dark controls reused the stroke color as a translucent surface | Separate input stroke tokens, card surfaces and muted hover; test text/stroke/status contrast | Fields remain identifiable without making every structural separator heavy |
| HIGH | Layout | `src/features/memory/memory-panel.tsx:131` | Export tab extended past the 320px viewport | Wrapping tab row with mobile target height | All memory views stay reachable on narrow screens |
| HIGH | UI | `src/features/terminal/terminal-workbench.tsx:43`, `src/features/execution/execution-workbench.tsx:24`, `src/features/apps/inline-app.tsx:22` | Leaving a workbench or hiding an inline app could discard an unconfirmed operation's retry controls | Feed pending state and browser policy drafts into the existing navigation guard; keep same-ID retry; expose native cancellation/resolution; aggregate inline instances | The UI must not lose the handle for an uncertain action or encourage a duplicate attempt |
| HIGH | UI | `src/features/memory/memory-panel.tsx:167`, `src/features/routines/routines-workbench.tsx:215`, `src/features/apps/use-app.ts:30` | Search errors had no retry; initial loading could look empty; polling could blur load versus mutation failures | Search loading/no-match/retry, routine reload, Apps skeleton; preserve mutation failure until resolution | Errors have a recovery path and polling cannot dismiss uncertainty |
| HIGH | UI | `src/navigation/workspace.ts:41`, `src/agent/worker.ts:1317`, Terminal/Code saved-run links | Pi creates `command:` and `code:` receipt IDs, but routing rejected colons. Rendering a real command history crashed the whole Terminal collection into the invalid-link boundary. Auth return links also rejected encoded IDs. | Preserve namespaced IDs within a bounded, validated path segment; decode each URL segment once before validation. Reject separators, controls, malformed/double encoding and oversized values. | Routing must represent the owning domain's existing identity without changing receipts or repeating execution |
| MEDIUM | UI | `src/features/apps/apps-workbench.tsx:74` | Two New checklist flows produced different authoritative states | Apps links to Checklists; removed legacy manual builder, state and dead styles; existing generated apps still render | Users have one durable checklist creation/editing journey |
| MEDIUM | Writing | Settings, Apps, Checklists, Browser, Terminal, Code, Routines and conversation empty state | Repeated privacy, owner, title, welcome and explanatory filler | Removed duplication and shortened copy; kept limits, permission consequences, draft/archived states and blockers | Visible text should help make a decision or understand current work |
| MEDIUM | UI | `src/components/copy-button.tsx:18`, factor settings and webhook panel | Separate clipboard implementations had different feedback and sounds | One typed copy control for answers, code, recovery codes and webhook values | Consistent success/error feedback without duplicate clipboard logic |
| MEDIUM | UI | `src/features/skills/skills-panel.tsx:124`, agents/connections/routine forms | Inconsistent editor-tab guards; empty form buttons could give no validation feedback | Disable replacement tabs while editing; native required/non-whitespace constraints and submit validation | Preserve draft editing context and show what input is missing |
| MEDIUM | Typography | `src/styles.css:161`, mobile Input/Textarea/InputGroup, `src/components/ui/button.tsx:6` | Fixed body size; small editable text and compact touch buttons on phones | Relative body size, unitless leading, 16px mobile fields and 44px shared mobile buttons | Improve resizing and touch use without expanding desktop controls |
| LOW | UI | `src/components/ui/button.tsx:6`, `src/components/ui/tabs.tsx`, obsolete Apps welcome styles | Broad `transition-all` and unused style rules from removed surfaces | Limit transitions to actual visual properties; delete unused rules | Avoid accidental layout motion and dead presentation code |

## Verification

### Passed locally

- `pnpm verify`: routes, TypeScript, 645 tests in 83 files, native workerd recovery suite and production build. The native suite kills/restarts worker processes and checks replay, bot isolation, loop recovery and receipt guarantees. These are existing backend regressions, not proof of a browser operation reaching an external provider.
- `pnpm lint`: zero errors; four existing `no-shadow` warnings outside this change. `pnpm check` and `git diff --check` pass.
- New `tests/theme-contrast.test.ts`: text >=4.5:1, input/focus tokens >=3:1 on their intended surfaces, semantic actions/statuses >=4.5:1. Rendered dark General controls checked separately; token tests do not prove every opacity combination.
- Synthetic local browser fixture renders the actual route and feature components. It controls responses and performs no account changes or external execution. Checked sign-in/password visibility, setup/recovery entries, empty-email native validation, unavailable reset token, authenticator/recovery-code switch and OTP/button equal widths.
- Checked agent menus, protected default agent, archive confirmation with Cancel initially focused, search/palette (`Cmd+K`, query, Enter), native resource links and settings routes. Archive was cancelled; no live bot was changed.
- Checked General appearance/sound test/delivery, model defaults, security session-confirmation cancellation and factor entry/back; connections native validation/cancel, skills editor/cancel, file preview/source/rename/save/cancel and return focus.
- Checked browser/network draft controls with Cancel; terminal tabs, command/session errors, same-ID retry and native cancellation request; code fixture returns the known sum `6` and a resource URL. No browser network policy, sandbox or external command was changed for this audit.
- Checked Apps list/version/preview controls; controlled 503 on an app edit preserves Retry/Resolve across polling and disables leave controls. Resolve restores editing. Repeated the same case inline in chat: Hide app disabled, sidebar inert, navigation disabled; successful resolution unlocks them. The fixture proves UI lifecycle, not server reconciliation.
- Edited the checklist's existing task: revision 4 -> 5, progress 1/2 -> 2/2 and Saved state. Inspected task notes/dates/editor/cancel. Created a paused synthetic routine; inspected schedule and webhook entry. No real routine ran.
- Memory provenance and tree entries; delayed search status; no-match/Clear; first-query outage -> Retry -> sourced original result. Export/import tabs are reachable at 320px.
- Activity timeline, task details (communication, model usage, plans), saved-conversation detail and close/focus return. The saved view retains original text and committed tool output; no approval or retry was issued from history.
- Mobile checks at 320/390/640 CSS pixels: nested workbench/menu/settings drawers, field/control dimensions, Memory reflow, checklist editor and file Options/Rename return focus. Keyboard tab sequence stays inside Settings. Reduced-motion emulation reports zero dialog animation/transition duration. Temporary viewport/media overrides reset afterwards.
- Final pass: Browser policy editing and in-flight owner commands now use the same navigation guard as Terminal. Browser/Terminal policy cancellation returns focus to the settings opener; verified by actual focus and restored navigation, without saving a policy.
- Paper: removed the duplicated settings tagline from the existing Models/settings artboard (`6T-0`); inspected the result and finished the editing session.

### Not verified

- Native browser 200% zoom, screen-reader output, physical iOS/Android devices, RTL and translated content. The 640px check is constrained reflow, not a claim that browser zoom was exercised.
- Real 2FA enrolment/disable, credential changes, recovery-code disclosure, session revocation, permission grants, network policy changes, webhooks, model responses, uploads/video processing or external execution. Their callers/controls and existing deterministic coverage were reviewed; a personal account is not disposable test data.
- Browser-crash persistence of an unconfirmed terminal/code/app request is not added by this change. In-view navigation is guarded; existing durable backend receipts remain authoritative. Code cancellation of an ID never admitted by the server retains its retry handle when the native endpoint returns unavailable.
- No existing Code receipts were available in the owner bot for the final hosted resource-link check. Its collection loaded; namespaced Code receipt links and history are verified locally. No code was executed to manufacture hosted audit evidence.
- One automated Close settings click immediately after capturing a screenshot left Settings open. The enabled control worked on the next inspected attempt and on three subsequent first-click journeys. This was not reproduced without screenshot capture; its cause remains unestablished and is not claimed fixed.
- Hosted release checks are recorded below. The local fixture is not hosted acceptance.

## Release evidence

[PR #81](https://github.com/cill-i-am/durable-pi/pull/81) merged as `d343c43`. Both branch checks passed on final head `d28bc0b`; main checks, Alchemy deployment and hosted authentication probes passed in [production run 38333644684](https://github.com/cill-i-am/durable-pi/actions/runs/38333644684).

Read-only hosted acceptance after that deployment confirmed:

- Apps title `Apps — Pi`, native Checklists link and no legacy New checklist app control.
- Checklists title `Checklists — Pi`, `/agents/home/objects` path and one New checklist entry.
- General settings has its own `/agents/home/settings/general` path, native section links, no old tagline and the expected dark input/card styles. Test sound control exercised; no appearance or sound preference changed.
- Settings Memory & data opens the actual Memory workbench. At 320px all four tabs, including Export & import, fit within the viewport; document scroll width is 320px. The export view is `/agents/home/memory?tab=files`, title `Memory — Pi`, with native HTML/JSONL download links. Nothing was exported or imported.
- Restored the viewport after testing. Saved a private, ignored screenshot of the General settings dialog; no transcripts or credentials are included in public source.

The final source comparison also found an inconsistent Browser policy draft guard and missing focus return after Browser/Terminal policy cancellation. [PR #82](https://github.com/cill-i-am/durable-pi/pull/82) merged as `fc0f8fe`; the [production workflow](https://github.com/cill-i-am/durable-pi/actions/runs/38334915296) passed the full checks and deployment. Hosted Browser policy editing locked surrounding navigation; Cancel released it and returned focus to Browser internet settings. No policy was saved.

That hosted pass exposed the saved-command URL blocker in the findings table: direct Terminal load and Browser -> Terminal navigation both failed when real Pi receipts appeared. The initial synthetic command used a plain ID and did not exercise this contract. The corrected fixture uses `command:preview-task` and verifies collection rendering, a native encoded resource link, output display, Settings -> Close returning to that exact resource, and no new command. Four focused checks failed before the correction. New native TanStack location/history tests cover both Terminal and Code, auth return paths and Settings; additional cases reject encoded separators and malformed IDs. The shared error heading now describes a workspace failure without falsely claiming every failed render has an invalid URL.

Final route-correction validation: 666 tests in 83 files, TypeScript, native workerd restart/replay suite and production build passed. One first-run backup test exceeded its existing five-second timeout under the parallel suite; it passed in isolation and in the full rerun without changing its timeout or implementation. Lint retains the four existing warnings; formatting, diff and tracked-file credential checks passed.

[PR #83](https://github.com/cill-i-am/durable-pi/pull/83) merged as `9ab7160`. Both branch checks passed on `6afeceb`; main checks, Alchemy deployment and hosted authentication probes passed in [production run 38337175914](https://github.com/cill-i-am/durable-pi/actions/runs/38337175914). Hosted acceptance after deployment confirmed:

- Terminal history renders instead of crashing. An existing Pi-generated command link opens the saved Output view; its encoded resource URL survives direct reload. No command was started, retried or cancelled.
- General Settings preserves the selected receipt in view-state query parameters. Closing Settings returns to that exact receipt and Output view. Three further first-click open/close journeys passed; the isolated screenshot-adjacent observation is retained above.
- Switching to Browser clears the selected receipt. Browser and Terminal internet-settings drafts disable Hide workbench and make the sidebar inert. Cancel releases navigation and returns focus to the corresponding settings opener. No network settings were saved.
- The Code collection loads at its own URL. It has no saved receipts in this owner bot; that hosted detail journey remains unverified.
- Saved an ignored screenshot of the deployed General settings dialog. Private transcripts, receipt identifiers and credentials are not published. Temporary browser viewport/media overrides were restored.

## Verdict

Approve for the six inspected domains and the verified local/hosted scope. The reproducible HIGH findings are fixed, all five passes are complete, and the final receipt-route correction passed CI, deployment and hosted acceptance. The specific unverified environments, consequential actions and isolated observation above remain explicit limits of this audit.

## Activity acceptance follow-up

Subsequent hosted acceptance of the compact activity trail reproduced a transcript flash after two one-time approvals. The mutation callback recreated the TanStack client even though the existing Pi stream publishes committed access and run changes. Removing these redundant refreshes from approval, send, retry and cancellation keeps the current transcript mounted. Manual reconnection remains separate. Local coverage verifies one native subscription through approval/cancellation updates, and actual-component browser verification retains the transcript immediately after approving. This is an additional finding after the five completed audit passes.

[PR #85](https://github.com/cill-i-am/durable-pi/pull/85) and [PR #86](https://github.com/cill-i-am/durable-pi/pull/86) passed checks, merged and deployed. Hosted acceptance used an isolated synthetic bot and the existing ChatGPT connection. The compact trail retained original results after reload, opened the owning bot's Memory, Browser and Code routes, and preserved the transcript through send and one-time approval without opening another conversation stream. Two separately requested code calls produced two distinct native receipts; a saved result route survived reload without repeating execution. A 390px hosted viewport had no horizontal overflow; both themes were inspected. The test bot was archived through the confirmation dialog. Exact release evidence is in BUILD.md. Physical-phone gestures, screen readers and forced production restart remain outside this verification; native restart/replay coverage passed locally.
