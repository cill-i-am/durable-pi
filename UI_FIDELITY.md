# Paper fidelity

Requested after the functional build. Reference: [Pi — Quiet Workroom · Product design](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-1-0), page “Quiet Workroom · Complete product states”. Re-read 2026-10-11: 36 artboards; tokens hash `30a00488`. This is implementation of the approved design, not a new visual direction.

## Outcome

Bring the deployed product as close as possible to the Paper layouts and states while preserving its actual permissions, durable operations, recovery, model routing and owner data. Use shadcn/Base UI, existing feature boundaries and semantic tokens. Read exact styles/JSX from Paper; use screenshots for verification. Never display fictional live status or enable an unsupported action for visual parity.

Visual thesis: a light, compact workroom with white working surfaces, a soft green-gray sidebar, forest-green actions and friendly agent marks. The workspace is the content: navigation, conversation and contextual workbench. Menus, drawers and selection transitions remain brief and respect reduced motion.

## Slices

| Slice | Paper references | Acceptance | Status |
| --- | --- | --- | --- |
| F1 — Foundations and access | 05–07 Access; 31 System | Exact semantic palette, Geist typography, agent mark, responsive login/setup/recovery; retain owner-only authentication and recovery behavior | Deployed in PR #34; hosted access verified |
| F2 — Workspace and navigation | 02 Workroom; 03 Navigation; 04 Search; 08 Agents | 48px workspace bar, 224px desktop sidebar, functional Agent/View/Tools menus, keyboard search, agent editing, compact conversation header | Deployed in PR #35; hosted deployment passed |
| F3 — Conversation | 11–19 Conversation, attachments, steering, permissions, recovery | Readable message rhythm, composer, actual thinking/tool/approval/steering states, image/video attachments and anchored context | Deployed in PR #36; hosted deployment passed |
| F4 — Workbench | 09 Delegation; 10 Settings; 20–27 Browser, terminal, files, apps, activity, memory, recovery | Consistent tabs and contextual panes, actual settings/actions, stable unsaved-work and navigation fences | Implemented and locally verified; deployment follows this PR |
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


Hosted F1 evidence: PR #34 merged as `2f5987e`; production run `38132564840` passed. The deployed unauthenticated access screen at bot.cill-i-am.com uses Geist and the exact primary token, has no horizontal overflow, and passes axe with zero violations or incomplete checks. This check did not sign into the owner's account.

### F2 — Workspace and navigation

The desktop workspace now follows the 48px menu bar and 224px sidebar. Agent/View/Tools use shadcn's Base UI Menubar. Command search uses cmdk inside the existing Base UI Dialog, opens with Cmd/Ctrl+K, searches active agents and working navigation commands, and transfers focus correctly to agent editing. Agent rows and the compact 68px split conversation header use the Paper agent marks. Activity and memory remain directly reachable.

Intentional adaptations: search advertises agents and commands only; conversation search remains in each agent's memory. The personal menu shows actual owner/workspace information without a fictional save indicator. Agent creation/editing retains the existing modal and supported name/instructions fields; default models, tools and connections remain their actual separate controls. The broader settings/workbench composition is F4. On phones the existing sidebar and conversation controls remain, with keyboard command search responsive; the final touch navigation composition is F6. Adding cmdk introduced its transitive dependencies but did not upgrade unrelated installed dependencies.

Local evidence: 422 tests in 62 files, typecheck, lint and production build passed. Independent review is clear after moving the Close button outside cmdk's Enter handler and preserving mobile focus return. Browser QA measured a 48px bar, 224px sidebar and a centered 620px command dialog at y=168 on a 1440×900 viewport. A synthetic agent was created, edited and archived through the new navigation. Menu and command transitions, keyboard dismissal, desktop split-pane opening, mobile search at 390×844, no horizontal overflow, and an unsaved checklist's navigation fence passed. The pending draft prevented agent/menu/command navigation; cancel restored it. Local desktop split-pane, search and mobile search axe audits have zero violations; incomplete checks are Base UI focus guards and the existing decorative owner initial. Screenshots remain in ignored local evidence, including `screenshot-1791715623376.png` (split workspace), `screenshot-1791715641645.png` (desktop search) and `screenshot-1791715655730.png` (mobile search). These are local synthetic-data checks, without a production model connection. Hosted authenticated navigation remains unverified for this slice.


Hosted F2 delivery: PR #35 merged as `ce1a570`; production run `38133447207` passed, including the unauthenticated owner boundary. Authenticated hosted navigation was not exercised.

### F3 — Conversation

Paper's fresh-chat introduction, flat suggestion rows, green owner bubbles, agent mark, readable assistant rhythm, collapsible thinking/tool rows and 14px composer now share the same layout. Suggestions fill and focus an empty draft without sending. Image/document attachment cards and the drop target use the existing bounded upload pipeline. The explicit Send/Steer/Queue actions preserve their existing delivery semantics, acknowledgement handling and cancellation. Queued follow-ups no longer become the native message scroller's current-turn anchor or create an empty assistant row.

Approval presentation reflects durable status: pending requests alone expose Allow once/Deny; expired, cancelled, interrupted and completed actions display their actual outcome. Nine focused regression cases cover these controls and the stopping fence.

Intentional adaptations: completed tool labels use the darker primary-hover token and owner timestamps use foreground to meet contrast requirements on tinted surfaces. Chat exposes existing image previews and attachment/extraction status; Files provides downloads, extracted text and prepared video frames, with its richer presentation addressed in F4. Point/region asset annotations are not implemented. No playback, upload percentage, draft persistence or provider status is fabricated. Native shadcn MessageScroller remains responsible for scroll following. Its supported scroll-to-message API handles an existing queued row becoming active; it advances only when the previous viewport was at the live edge and preserves manual reading above it.

Local evidence: 431 tests across 63 files, typecheck, lint and production build passed. Independent review covered draft acknowledgement, bot isolation, uploads, steering, approval controls and the queued-anchor correction. Real local text drag/drop and image-picker uploads completed through the existing API; attachments were removed from the composer without losing its draft. Browser-only state fixtures exercised running/expanded tool output, steering, queued follow-ups, pending approval, stopped/retry and completed replies with model/mutation routes blocked. These fixtures demonstrate presentation, not model execution or recovery. An actual same-page queued-to-preparing transition after a long reply made the new turn visible; keyboard navigation to earlier content stayed in place through that transition. Desktop 1440×900 split workbench and mobile 390×844/320×568 fit without horizontal overflow. Pending-approval and stopped mobile screens and expanded-tool desktop audit have zero axe violations; desktop incomplete checks concern existing focus guards/decorative initials. Representative screenshots: `screenshot-1791715943609.png` (mobile fresh), `screenshot-1791715991851.png` (real attachments), `screenshot-1791716224823.png` (pending approval), `screenshot-1791716235418.png` (320px stopped), `screenshot-1791716262832.png` (expanded tool/queue split) and `screenshot-1791716270105.png` (completed). Screenshots and fixtures stay in ignored local evidence. Authenticated hosted conversation is not yet verified for this slice.


Hosted F3 delivery: PR #36 merged as `b47a437`; production run `38134211346` passed, including the unauthenticated owner boundary. Authenticated hosted conversation was not exercised for this visual slice.

### F4 — Shared workbench

One stable shadcn/Base UI workbench owns Paper's 664px desktop pane and 48px tab strip. Browser, Terminal, Files, Apps and Activity remain the primary tabs; More retains Objects, Memory, Code and Routines. The same portal and feature instance survive desktop/mobile resizing. Existing domain operations remain in their feature slices. Files and conversation share the selected bot's file state; Memory uses its current conversation projection. Files has a compact explorer and image/text/prepared-frame preview. Memory notes expose their original source through the existing bot-scoped archive endpoint. Activity adds agent marks and consistent time/content lanes.

Intentional adaptations: private bot files remain a flat collection; no fictional folders, search, frame annotation or editing API is added. Memory is inspectable, with original-message provenance, but no unsupported note-edit action is shown. Actual model, tool-access, connection and skill settings retain their existing supported controls. Models stay subscription-only; Paper's API-key/shared-note mock controls are not implemented. The terminal keeps the explicit command/session, checkpoint and network constraints required by the runtime. Extra implemented tools remain reachable in More. Muted tabs use the accessible semantic foreground instead of the default translucent foreground.

Local evidence: 431 tests in 63 files, typecheck, lint and production build passed. Independent reviews covered lifted state, acknowledgement handling, recovery navigation, breakpoint stability, previews and source-request cancellation. Browser QA at 1440×900, 390×844 and 320×568 verified terminal draft retention across resizing, keyboard tab activation, file selection/rename/text preview, a real upload while renaming, attachment selection without losing the chat draft, memory source inspection and mobile overflow. A restored synthetic unconfirmed object mutation kept Objects reachable while all unrelated navigation stayed locked; the real cancellation operation removed the pending save and unlocked navigation. A new checklist draft survived resizing and Escape could not dismiss it. Review corrections preserve the default file selection across uploads, use distinct detail/preview keys, and retain access to object recovery after reload. Terminal desktop, Files desktop/mobile and Memory desktop/mobile axe audits report zero violations; incomplete checks involve modal focus guards and decorative initials. Native domain/runtime coverage remains unchanged; browser memory data was a read-only presentation fixture, not a new model run. Screenshots include `screenshot-1791716992393.png` (terminal desktop), `screenshot-1791717060439.png` (file preview), `screenshot-1791717074840.png` (restored save recovery), `screenshot-1791717127298.png` (320px Files) and `screenshot-1791717157785.png`/`screenshot-1791717158051.png` (memory provenance desktop/mobile). Fixtures and screenshots remain ignored local evidence. Authenticated hosted workbench verification is not claimed.
