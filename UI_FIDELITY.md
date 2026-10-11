# Paper fidelity

Requested after the functional build. Reference: [Pi — Quiet Workroom · Product design](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-1-0), page “Quiet Workroom · Complete product states”. Re-read 2026-10-11: 36 artboards; tokens hash `30a00488`. This is implementation of the approved design, not a new visual direction.

## Outcome

Bring the deployed product as close as possible to the Paper layouts and states while preserving its actual permissions, durable operations, recovery, model routing and owner data. Use shadcn/Base UI, existing feature boundaries and semantic tokens. Read exact styles/JSX from Paper; use screenshots for verification. Never display fictional live status or enable an unsupported action for visual parity.

Visual thesis: a light, compact workroom with white working surfaces, a soft green-gray sidebar, forest-green actions and friendly agent marks. The workspace is the content: navigation, conversation and contextual workbench. Menus, drawers and selection transitions remain brief and respect reduced motion.

## Slices

| Slice | Paper references | Acceptance | Status |
| --- | --- | --- | --- |
| F1 — Foundations and access | 05–07 Access; 31 System | Exact semantic palette, Geist typography, agent mark, responsive login/setup/recovery; retain owner-only authentication and recovery behavior | Implemented; local checks and independent review passed; deployment follows this PR |
| F2 — Workspace and navigation | 02 Workroom; 03 Navigation; 04 Search; 08 Agents | 48px workspace bar, 224px desktop sidebar, functional Agent/View/Tools menus, keyboard search, agent editing, compact conversation header | Pending |
| F3 — Conversation | 11–19 Conversation, attachments, steering, permissions, recovery | Readable message rhythm, composer, actual thinking/tool/approval/steering states, image/video attachments and anchored context | Pending |
| F4 — Workbench | 09 Delegation; 10 Settings; 20–27 Browser, terminal, files, apps, activity, memory, recovery | Consistent tabs and contextual panes, actual settings/actions, stable unsaved-work and navigation fences | Pending |
| F5 — Working objects | 33 Live checklist; 34 Conflict/recovery/history; 35 Mobile checklist | Match inline and workbench layouts with saving/saved/conflict/error/archive/history states; one authoritative checklist | Pending |
| F6 — Mobile and final verification | 28–30 Mobile plus responsive access and object screens | Match 390px layouts, touch targets, safe areas and keyboard; recheck desktop at 1440px, all state groups, review, CI and hosted deployment | Pending |

Artboards 00–01 document the direction/treatment; 32 explores object alternatives. Implement the selected live-checklist direction. Extra implemented capabilities—code execution, routines, skills and model-policy detail—use the same composition rather than disappearing from navigation.

## Verification

- Save before/after screenshots at matching viewport sizes using synthetic local data. Include representative loading, empty, running, completed, approval, error, connection-lost, conflict and archived states.
- Check navigation and keyboard behavior, mobile overflow, readable contrast, modal focus return, reduced motion and unsaved-work fences. Keep real response/recovery semantics, including unknown or failed mutations.
- Run relevant local checks and meaningful interaction tests. Keep fixture-based visual evidence distinct from native runtime and authenticated hosted evidence.
- Review each substantive slice and ship through the existing signed-commit/PR/CI/main-deployment workflow. No credentials, browser auth state, private conversations or generated private assets enter the public repository.

## Intentional adaptations

- Mobile browser chrome and the operating system status bar in Paper are references, not app UI to reproduce.
- Model labels come from verified subscription capabilities. No API-key connection or fallback is added.
- Save/running/connection indicators must reflect durable state; do not copy “All changes saved” into a surface that cannot prove it.
- Preserve newer capabilities and security controls even where the initial artboards omit them. Record further departures with their reason and screenshot evidence.

## Evidence log

2026-10-11 baseline: Paper inspected through MCP. Main workroom specifies a 48px workspace bar, 224px sidebar, 68px conversation header and 664px workbench at 1440×900. Mobile reference is 390×844. Current product lacks the shared workspace bar/tab composition and uses approximate colors/avatar marks; start with foundations and access before changing navigation.


### F1 — Foundations and access

Uses Paper’s exact light palette, Geist/Geist Mono, 6/10/14/20px radii and original agent-mark SVG. The desktop access composition follows the 620/820px split and 380px form at 1440×900; setup and recovery share the same frame. The static workspace illustration is explicitly labeled as an example. Owner setup, workspace sign-in and subscription connection remain distinct. Password visibility controls preserve field constraints and pending state.

Intentional accessibility adaptations: editable controls remain 16px on phones to avoid focus zoom; primary-button hover uses opaque `#126b5a` rather than translucent green, preserving text contrast. Mobile omits the decorative story, retains the Pi brand and scrolls on short viewports.

Local evidence: 422 tests across 62 files, typecheck and production build passed. Eight focused authentication/email tests also passed. Browser checks at 1440×900, 390×844 and 320×568 cover sign-in, setup, recovery, an unavailable reset link, password visibility, keyboard navigation and horizontal overflow. A synthetic local owner signed in and signed out successfully. Settled desktop/mobile access screens and the primary-button hover audit have zero axe violations. Mobile conversation has zero violations; its decorative initial-letter avatar needs manual contrast interpretation and will be replaced in F2. Independent review identified the mobile-input and hover-contrast regressions; both were corrected and re-reviewed clear. This is local evidence; hosted deployment verification is recorded separately after merge.
