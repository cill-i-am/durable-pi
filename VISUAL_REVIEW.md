# Live visual refinement

## Scope and coverage

Five focused passes using better-accessibility, better-layout, better-writing, better-typography, better-colors and better-ui. Preserve the Paper layout, Linear-inspired semantic colours, Geist fonts, shadcn/Base UI primitives and TanStack routing. The earlier correctness audit remains in UI_AUDIT.md.

Baseline: production main `163ec93`. Reuse docs/navigation.md and docs/responsive-overlays.md. No AGENTS.md, CONTRIBUTING.md or CLAUDE.md was found. Personal transcripts and account credentials stay out of public screenshots and reports.

| Pass | Focus | Status |
| --- | --- | --- |
| 1 | Live navigation, collections, agent editor, account menu and all six Settings sections | Complete |
| 2 | Live conversation and all nine workbench interiors | Complete |
| 3 | Light/dark comparison, 320/390px layouts, reading measure and rendered colour pairs | Complete |
| 4 | Implement recommendations and verify actual components with synthetic data | Complete |
| 5 | Whole-diff review, CI, release and hosted acceptance | Complete |

These are complementary passes, not a claim that every possible state was exercised five times. Hosted inspection used the signed-in owner session. Consequential account changes, permission changes, external execution and private exports were excluded. Authentication, editable objects and failures are exercised locally with synthetic data through the real frontend, routes and TanStack stream projection.

| Domain | Evidence | Result |
| --- | --- | --- |
| Accessibility | Native links, selected permissions, workbench labels, keyboard Tab/Escape in the nested security drawer | Add a visible selection mark; preserve focus return and native navigation |
| Layout | Live history rows, file list, selected extra tabs; 1024px desktop and 320/390px mobile measurements | Repair shared class resolution and native-link selectors; cap toolbar at five items |
| Writing | General/Models/Skills Settings and saved-notes empty state | Remove repeated heading/provider copy; distinguish notes from archived messages |
| Typography | Live wide transcript and file preview, then actual local components | Use 16px long-form text, unitless 1.6 line height and a 72ch prose measure |
| Colors | Rendered light/dark text pairs and terminal editor boundary | Keep palettes; restore input-border role for terminal editor |
| UI | Workbench hierarchy and creation entry points; shared toggle transitions | Match headings/actions; limit transitions to changed properties |

## Findings and changes

Severity applies to the observed baseline. All findings below are consolidated root causes, not separate reports for each affected instance.

| Severity | Domain | Source | Before | After | Why |
| --- | --- | --- | --- | --- | --- |
| Medium | Layout/UI | src/components/ui/button.tsx:43 | Native history links kept conflicting utility classes. Live computed alignment was `center` despite callers requesting `justify-between`. | The exported helper and Button both merge overrides. Actual local history alignment is `space-between`. | Labels and outcomes align predictably across native links, including terminal/code history and settings navigation. A red-capable public API parity test failed before and passes after. |
| Medium | Layout | src/styles.css:1502 | Three file-list selectors targeted buttons after rows became native links. Live file rows inherited the wrong weight/size/layout. | Target the existing `data-slot="button"` on those links. | Keep semantic links and the intended full-width, left-aligned compact rows. |
| Medium | Layout/Accessibility | src/app/workbench.tsx:77 | Selecting an extra tool appended a sixth tab. Desktop labels clipped; at 320px Checklists needed 52px inside a 49px slot. | Keep five tabs, move Activity into More while an extra is active, and omit the active extra from that menu. Add full accessible names/titles. | At 320px Checklists has a 59px slot and no overflow. Activity remains reachable; URLs and pending guards stay unchanged. |
| Medium | Typography | src/styles.css:2878; src/styles.css:2816 | Wide transcript: 804px of 14px text with fixed 20px line height. File prose used 13px and conflicting fixed line-height rules. | Assistant/file prose uses 16px and 1.6 line height; assistant paragraphs/lists/quotes cap at 72ch. Remove the redundant file rule. | Improve reading comfort and text scaling while code, tables and inline apps retain their available width. |
| Medium | Accessibility/Colors | src/features/access/access-panel.tsx:132 | Allow/Ask/Deny selection relied on a subtle background change. | Show a check on the confirmed selection, reserving icon space. | Selection remains legible independently of colour. A failed synthetic mutation retained Ask and its check; no permission policy changed. |
| Medium | Colors | src/styles.css:2252 | Terminal editor border equalled its fill. Against the dark panel it was 1.14:1. | Use the existing input border token. | Restore the boundary of an editable control without changing terminal colours or execution. |
| Low | Layout/UI | src/features/execution/execution-workbench.tsx:38; src/features/routines/routines-workbench.tsx:207; src/features/objects/workbench.tsx:65 | Code/Routines titles were smaller non-headings; creation actions occupied an extra body row. | Reuse the workbench heading style; place one New checklist/routine action beside its heading. Recent routine runs becomes h3. | Consistent hierarchy and a single creation entry; original disabled/pending behaviour is retained. |
| Low | Writing/UI | src/app/workspace-settings.tsx:232; src/features/memory/memory-panel.tsx:157; src/features/skills/skills-panel.tsx:511; src/features/conversation/model-defaults.tsx:112; src/features/files/files-panel.tsx:305 | Repeated section/provider copy, vague skills prompt, notes that promised to appear automatically, and an unexplained blank file preview. | Delete redundant copy, provide specific empty-state guidance, and distinguish saved notes from the message archive. | Users can tell what exists and what action to take without duplicate actions or promotional filler. |
| Low | UI | src/components/ui/toggle.tsx:6 | `transition-all` also animated layout changes. | Transition colour, background, border and shadow only. | Avoid incidental movement when a control's content or size changes. |
| Medium | UI/Accessibility | src/app/workspace.tsx:374; src/app/workbench.tsx:87; src/styles.css:3130 | Closing the route unmounted the panel immediately, cutting off its exit animation. | Retain only the last panel/selection until Base UI completes closing; mark the closing dock inert. Animate dock width and native popup transform; return focus to the open control. | The URL changes immediately. Native lifecycle handles rapid reopen and reduced motion without a timer or another action authority. |
| Low | Layout/UI | src/styles.css:1071; src/styles.css:1120 | Tool disclosure hover surfaces put icons and chevrons against the edges. A later Thinking rule also removed its row padding. | Use 8px vertical and 12px horizontal padding on the group and all activity rows; align expanded details and connectors with the labels. Remove the conflicting Thinking layout override. | Match the padded surface across completed, failed and thinking disclosures without adding another card. |

## Colour measurements

Ratios use the actual rendered foreground/background, including the selected surface, not inferred token names.

| Pair                                              | Ratio   |
| ------------------------------------------------- | ------- |
| Light body #28282c / white                        | 14.68:1 |
| Light secondary #67676f / white                   | 5.61:1  |
| Light selected navigation #535fc6 / #ebebef       | 4.62:1  |
| Dark body #ededef / #242427                       | 13.24:1 |
| Dark secondary #a0a0aa / #242427                  | 5.97:1  |
| New light input border #8b8b95 / terminal #18181b | 5.25:1  |
| New dark input border #73737c / terminal #18181b  | 3.77:1  |

No palette replacement was warranted by these measurements. Borders separating decorative regions keep their quieter semantic token. Security consequences, run limits, confirmation copy, approval controls and raw execution evidence remain intact.

## Verification

- Public Button/native-link API regression test: failed before the fix, passed after.
- Final `pnpm verify`: 679 tests across 85 files, TypeScript, route generation, production build and native workerd/SIGKILL loop recovery passed. Lint had zero errors and four existing shadowing warnings; formatting passed.
- Browser acceptance uses actual frontend components and the existing synthetic API/stream fixture. Local effects stay inside that fixture; this does not prove a real model or external service ran.
- 1024px desktop and 320px mobile tabs have no internal clipping. At 320px the document and viewport are both 320px wide.
- Final compiled production CSS was inspected at 1280px: terminal history remains `space-between`, prose is 16px/25.6px, and all five tabs fit after the entrance transition settles.
- File selection/native detail route, code history/result route, checklist heading, routine editor, permission failure, both themes and nested mobile settings/security were inspected. Tab focused the top security drawer; Escape returned focus to Account security in General settings.

Screen-reader output, native browser zoom, translated/RTL content and physical-device swipe gestures remain unverified. Existing bottom-drawer behaviour is preserved; a device-metrics check is not a claim of physical iPhone testing. No production restart or external action is needed for this visual change.

The exit follow-up was checked through the actual component lifecycle with a synthetic fixture that slows only its CSS transition to 2 seconds for inspection. During closing, the URL had already returned to chat, the selected file remained visible, the dock was inert, its width was shrinking, and the popup carried Base UI’s ending state and a positive horizontal transform. Keyboard reopening before completion restored a single live panel. At 390px, Escape produced a positive downward transform and native cleanup; reduced-motion transitions were 0s and returned focus to Open workbench. Compiled production CSS uses 200ms desktop and 300ms mobile transitions; at 320px the document remains 320px wide. Temporary emulation and slow-motion styling are test-only and are not shipped.

## Release and hosted acceptance

[PR #88](https://github.com/cill-i-am/durable-pi/pull/88) merged as `0f7cba4`; its [production workflow](https://github.com/cill-i-am/durable-pi/actions/runs/38371233918) passed checks and deployment. [PR #89](https://github.com/cill-i-am/durable-pi/pull/89) merged the exit/padding follow-up as `6a25d3b`; both PR checks and its [production workflow](https://github.com/cill-i-am/durable-pi/actions/runs/38375058742) passed. The production run includes 679 tests, native recovery, lint, build and a scan of 499 tracked files with no credential matches.

Hosted acceptance used the signed-in owner session at https://bot.cill-i-am.com:

- The served stylesheet is `styles-DNdJmqaK.css`, matching the verified follow-up build. Assistant prose is 16px/25.6px with a 72ch maximum; terminal history computes to `space-between`, and its editor uses the input border token.
- General settings has one content heading. Light and Dark render correctly; the original Dark preference was restored. Confirmed access choices have visible checks; no permission was changed. Skills, saved notes and the unselected file preview show the revised guidance.
- Code, Routines and Checklists have the corrected headings and one creation entry. Selecting an extra tool keeps five toolbar links, moves Activity into More and omits the active extra from More. Native resource URLs remain intact.
- Tool-call and Thinking rows compute to `8px 12px` padding. The expanded completed group and its rows were inspected on the live app; screenshot proof stays in the ignored research folder.
- Closing a selected file changes the URL to chat immediately. Two observed native ending frames retained that file, marked the dock inert and showed increasing horizontal translation. The dock width shrank in parallel. Completion removed the host and returned focus to Open workbench; reopening produced one panel.
- At an emulated 390px width, the More menu stacked above the workbench. Escape closed only that menu and returned focus to its trigger. Chat then produced a positive downward translation in Base UI’s ending phase, followed by cleanup. Device-metrics overrides were cleared.

Hosted checks were UI/read-only resource checks. They did not run a model, submit an external action, edit owner objects, alter security or force a production restart. Early reopen under deliberately slowed motion, reduced-motion cleanup, pending-edit protection and a Markdown file preview were verified locally; physical phone gestures, screen-reader output, native zoom and translation/RTL remain unverified.

## Verdict

Approve for the reviewed domains: all eleven confirmed findings are fixed and no HIGH finding remains in this scope. CI, deployment and representative hosted acceptance passed. This does not certify the unverified checks listed above.
