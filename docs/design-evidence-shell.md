# Workspace shell implementation evidence

The shell follows the approved [Conversation First workspace](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-C-1). Exact JSX and computed styles were read before implementation; screenshots were used to compare rendering. The supplementary [Shell, search and recovery board](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-C-1/1J59-0) was created, reviewed and extracted before changing those missing states. It covers command search, loading geometry, unavailable/not-found recovery and the assistant action menu.

Executor's `executor` catalogue, `build-design`, `better-layout`, `better-ui`, `better-accessibility`, `xstate-effect`, `subagent-execution` and `design-exploration-swarm-paper` grounded the work. Personal Skills revision: `70d1c37ec652e2b2a9263be9f5899d40d22ef758e3f3156ded50f95227fa2608`. [Jakub's Less is more](https://jakub.kr/writing/less-is-more) informed removal of duplicated navigation, the bottom navigation bar and ornamental activity effects. The existing shared UI package remains the source of visual tokens and controls.

## Implementation

- One collapsible sidebar replaces the top navigation plus assistant sidebar. It contains actual assistants, creation, search, connections, account/family controls and compact assistant actions. The management list remains inside this shell; mobile uses the existing native sidebar drawer and a leading trigger in the collection title.
- Assistant settings are reachable through the assistant's menu. Account/security/preferences/libraries/family settings retain global routes. The menu never repurposes a global setting as assistant configuration.
- The current family and authenticated account are real data. Chats show only the actual user and assistant. No multiplayer permission, calendar, project or fabricated execution receipt was introduced.
- The neutral inset frame, Geist type, shared purple primary, textured controls and card depth follow Paper. Fixed shell geometry derives from the approved composition; component density remains owned by the shared primitives. Desktop control radii use the established package token where Paper has a small rounding difference.
- The browser-like workbench retains each visited tool and its draft. Router state is authoritative for the active tool; a per-tool query projection remembers the last resource/filter when switching. Never-opened tools do not mount. Explicit tab close releases the resource; hiding or expanding retains it. Native close acknowledgement remains fenced by the presence machine.
- Every retained tool reports its own pending state. A settled background tool cannot release another tool's navigation fence. Hidden tool callbacks cannot navigate the active tab. Portal visibility is separate from resource identity, so hiding a tab does not discard an unsent form.
- Settings hold an already-open workbench through their stack. Opening settings after hiding a retained workbench keeps it hidden. The account menu closes the mobile sidebar before opening settings, so dismissing settings returns to the same composer.
- Editing from the assistant collection retains that collection as backdrop; it does not start a conversation behind the editor.
- `WorkspaceMotion` projects the existing device preference into the shared Motion provider and native overlay CSS. OS reduced motion still takes precedence. This is a projection of the existing preference, not another writable controller.
- Eighteen obsolete forwarding/compatibility modules were removed. App consumers import shared controls directly. Legacy ignored props were removed, and former footer uses adopt `CardFrameFooter`. Native overlay/popup controllers remain local because their docking and deferred-action contracts are required for the working mobile flow.
- The old Inter dependency, decorative border/orb dependencies and unused visual modules were removed. Verification reports dependency drift rather than automatically relinking running test tools (`verifyDepsBeforeRun: error`).

## Review corrections

Independent review identified and corrected terminal locking, lost AppView drafts, hidden portal actions, unnamed collapsed account control, invalid closable-tab semantics, close-button focus return, desktop select interception, approval-owner startup admission, deferred actions after deactivation, workbench width clamping, and missing bounded tool scrolling. Each substantive correction has a behavior or rendered-geometry regression. Original approval identity/revision fencing and private data boundaries remain authoritative.

## Verification status

- Full root unit/build gate: 3,957 tests passed; application, route and worker builds passed.
- Native runtime gate: passed, including ownership, durable recovery, interruption, approvals, channels, files, memory and two-restart XState/Effect checks. Provider/model inference is synthetic in these fixtures; no production action was sent.
- Static gate: passed after source fixes; final formatting is repeated after evidence and integration corrections.
- Shared UI: 24 unit tests passed, plus the focused motion, keyboard, density, contrast and overlay browser evidence in the foundation report.
- Built website passkey ceremonies: passed. Real Better Auth and browser WebAuthn against local native fixtures.
- Two-build client upgrade: passed; retired asset recovery preserves the unsent draft and attachment with zero submissions.
- Full desktop/mobile browser sweep is being completed. Early failures from removed navigation were updated to the actual workflow without removing the behavior assertions. Resource recovery/scroll corrections and final answer checks are tracked in their owning reports.

This document records local evidence. CI, merge, deployment and production verification are separate delivery states.
