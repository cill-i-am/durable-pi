# Execution tools redesign evidence

Scope: existing Browser, Terminal, Code, Routines and Activity routes beneath an assistant. The workbench frame, tab ownership and outer mobile stack are owned by the workspace. This change redesigns their interiors and preserves their existing domain owners.

## Design before implementation

Read Executor's `executor` skill and visible catalogue, then `build-design`, `better-interface`, `better-layout`, `better-typography`, `better-accessibility`, `better-writing`, `better-colors`, `better-ui` and `mobile-native` from Personal Skills, revision `70d1c37ec652e2b2a9263be9f5899d40d22ef758e3f3156ded50f95227fa2608`. Read [Jakub's Less is more](https://jakub.kr/writing/less-is-more) live. Inspected the real components, route inputs and domain contracts before adding the designs. Read the Paper guide, confirmed Geist and Geist Mono availability, and reused the existing tokens (`fc280747`).

All five boards were added to [Build · Execution tools](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-G-0), arranged in three columns with aligned second row. Each contains the desktop tool, mobile bottom drawer, and task-specific detail/recovery compositions. All screenshots were reviewed and JSX/computed styles extracted **before** editing application components. The boards use fit-content heights so explanatory review states do not clip.

| Page | Paper | Actual states represented |
| --- | --- | --- |
| Browser | [Browser](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-G-0/1J7M-0) | Address, captured page, page text/links, owner controls, sensitive text input, internet policy, no allowed sites, unavailable preview, stale settings, session limits |
| Terminal | [Terminal](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-G-0/1J81-0) | Commands, output/history, interactive shell/save/discard, import/export, internet policy, saved workspace, uncertain request and cleanup recovery |
| Code | [Code](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-G-0/1J83-0) | JavaScript/input, framed result with extended context footer, logs/input disclosures, history, loading/empty, uncertain retry/cancel, interrupted/error/cancelled |
| Routines | [Routines](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-G-0/1J8E-0) | Active/paused/archive list, Edit and Actions, run history/stop, name/instructions/schedule/status editor, webhook/key, conflict resolution and unconfirmed changes |
| Activity | [Activity](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-G-0/1J8K-0) | Assistant/filter controls, timeline lanes, task criteria/steps, saved conversation/tool records, delegated/background history, empty/loading/interrupted/unavailable |

Screenshot checkpoint verdicts: Browser has clear preview/control hierarchy and readable disclosures; Terminal keeps output distinct without making the entire interface dark; Code groups editor/result/history with one primary action; Routines exposes Edit while moving secondary commands into one menu; Activity aligns time/avatar/title/action lanes and keeps status in text. Desktop content padding is 20 px; mobile is 16 px; section gaps are 20 px; body uses 14/22, secondary 13/20 and metadata 12/18 from the existing scale. Borders, card frames and textured buttons use the existing shared primitives/tokens.

## Implementation

- Each feature owns an imported stylesheet and a bounded flex layout, rather than depending on the previous global tool selectors. Foundations removed the superseded Browser/Terminal/Activity selectors from `src/styles.css` after this handoff.
- Browser presents the page directly, keeps readable text/links under native disclosures, and preserves preview-readiness, generation fencing, owner control and policy behavior. The compact URL form retains the existing Input and Button; the unrelated local InputGroup has a larger density and was deliberately not changed here.
- Terminal keeps command/input and output in the terminal palette, makes the remaining chrome neutral, and places command limits and checkpoint detail behind disclosures. Command history and output are separate presentation functions; command/session/transfer/lease owners are unchanged.
- Code uses the real shared CardFrame, CardPanel and extended frame footer for the result and its saved details. Sandbox limits/storage are available in a disclosure. Interrupted runs are never repeated by this presentation.
- Routines keeps Edit visible and puts Pause/Resume, Run now, Webhook and Archive in the established responsive menu, which becomes a bottom drawer on mobile. History and the editor retain actual schedules, revisions, attempts and stop recovery. Webhook usage instructions are a disclosure; key and security consequences remain visible.
- Activity uses consistent title sizes and fixed lanes with tabular times. Existing task, delegation, background, inference and saved-record controls remain. An unavailable assistant has a return action.
- `active?: boolean` defaults to true on Activity, Terminal and Routines. Activity's record dialog closes while inactive without erasing route selection; terminal/routine portal menus close while inactive. Deferred menu callbacks check a live active-view capability, invalidated on deactivation/unmount, so a retained hidden tool cannot start a stale command after drawer close. Domain progression remains in the existing Effect/XState owners.

## Verification

- Focused unit run: 7 suites, 90 tests passed (`browser-ui-lifecycle`, `terminal-ui-lifecycle`, `execution-ui-lifecycle`, `routines-ui-lifecycle`, `activity-controls-ui`, `activity-presentation`, `activity-query-owner`).
- Scoped browser coverage: 42 existing desktop/mobile cases passed across Browser controls, Code uncertainty/cancel, Terminal transfer cancellation/lease/session recovery, Routines ownership/revision/webhook recovery, and Activity observation fencing. An initial run exposed old navigation assumptions and a bare-CSS fixture loader; both were corrected and affected cases rerun.
- Added a true-mobile delayed-close race: hold the native menu's close animation, deactivate the retained tool, finish the animation, and verify zero status commands. The test passes with the guard. `F12_BREAK_ACTIVE_FENCE=1` removes that guard only inside the test bundle; the negative control fails with one unexpected status command. The existing isolated routines harness was missing its viewport meta, so its mobile project used a desktop CSS viewport; this was corrected before running the race.
- Closing a terminal tab now provides the explicit unmount boundary in its export cancellation test. Hiding a retained tab is a different operation; it must not masquerade as unmount.
- The isolated Routines fixture ignores CSS only for its ownership tests. Real visual checks use the built application with its actual styles.
- Typecheck and scoped lint passed after the final presentational extraction. Terminal history/output and routine history are separate presentation functions; lifecycle owners remain unchanged. Final repository gates are owned by the coordinating agent.
- The provider-free fixture was built successfully and served on `http://127.0.0.1:4399`. No live provider commands, messages, approvals, invitations or secrets were used. Agent-browser session `execution-tools-redesign` reviewed all five tools at 1280×900 and 390×844 with synthetic data. Browser's unavailable-preview controls, Terminal's completed result, Activity's timeline/filter lanes and Routines' scheduled instructions were inspected alongside Code. Activity's full-width select was corrected to the Paper title/filter row. Its scoped Code axe audit reported zero violations and one gradient-button contrast item requiring manual review.

The coordinating agent is retaining the shared fixture server for the remaining cross-page review. Physical iPhone gesture/keyboard/safe-area behavior remains unverified; desktop touch emulation is not a hardware claim. Final full-app screenshot comparison after the combined build and repository gates remain separate acceptance checks.
