# Paper fidelity

Requested after the functional build. Reference: [Pi — Quiet Workroom · Product design](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-1-0), page “Quiet Workroom · Complete product states”. Re-read 2026-10-11: 36 artboards; tokens hash `30a00488`. This is implementation of the approved design, not a new visual direction.

## Outcome

The initial six slices shipped through PRs #34–#39. Fidelity remains under review: shipping a screen is not proof of matching Paper. F8 tracks the current comparison and correction pass.

Bring the deployed product as close as possible to the Paper layouts and states while preserving its actual permissions, durable operations, recovery, model routing and owner data. Use shadcn/Base UI, existing feature boundaries and semantic tokens. Read exact styles/JSX from Paper; use screenshots for verification. Never display fictional live status or enable an unsupported action for visual parity.

Visual thesis: a light, compact workroom with white working surfaces, a soft green-gray sidebar, forest-green actions and friendly agent marks. The workspace is the content: navigation, conversation and contextual workbench. Menus, drawers and selection transitions remain brief and respect reduced motion.

## Current audit

The 2026-10-11 browser review reopened fidelity after the original F1–F6 delivery. The current Paper page contains 40 artboards. The earlier completion entries are delivery history, not proof that the current UI matches every designed interaction. See F7 below.

## Slices

| Slice | Paper references | Acceptance | Status |
| --- | --- | --- | --- |
| F1 — Foundations and access | 05–07 Access; 31 System | Exact semantic palette, Geist typography, agent mark, responsive login/setup/recovery; retain owner-only authentication and recovery behavior | Deployed in PR #34; hosted access verified |
| F2 — Workspace and navigation | 02 Workroom; 03 Navigation; 04 Search; 08 Agents | 48px workspace bar, 224px desktop sidebar, functional Agent/View/Tools menus, keyboard search, agent editing, compact conversation header | Deployed in PR #35; hosted deployment passed |
| F3 — Conversation | 11–19 Conversation, attachments, steering, permissions, recovery | Readable message rhythm, composer, actual thinking/tool/approval/steering states, image/video attachments and anchored context | Deployed in PR #36; hosted deployment passed |
| F4 — Workbench | 09 Delegation; 10 Settings; 20–27 Browser, terminal, files, apps, activity, memory, recovery | Consistent tabs and contextual panes, actual settings/actions, stable unsaved-work and navigation fences | Deployed in PR #37; hosted deployment passed |
| F5 — Working objects | 33 Live checklist; 34 Conflict/recovery/history; 35 Mobile checklist | Match inline and workbench layouts with saving/saved/conflict/error/archive/history states; one authoritative checklist | Deployed in PR #38; hosted deployment passed |
| F6 — Mobile and final verification | 28–30 Mobile plus responsive access and object screens | Match 390px layouts, touch targets, safe areas and keyboard; recheck desktop at 1440px, all state groups, review, CI and hosted deployment | Deployed in PR #39; hosted deployment and access checks passed |

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


F4 delivery: PR #37 merged as `7565a1d`; production run `38134941867` passed, including the unauthenticated owner boundary. The Apps draft also survived local desktop/phone resizing. Authenticated hosted workbench was not exercised.

### F5 — Working objects

The live chat card follows Paper's 16px title, 14px radius, compact task lanes and Open checklist footer. The workbench uses the 24px heading, 64px desktop rows, Tasks/History line tabs, contextual editor and readable draft-versus-saved comparisons. Mobile keeps an editable 44px task/action rhythm and 16px fields; the status/date columns stack at 320px. Saved revisions, pending/error/conflict receipts, archived state and user/agent history still come from the same ObjectStore.

Intentional adaptations: retain explicit task status beside due dates, actual saved revisions and runtime recovery actions even where the mock is more compact. Changes continue to use targeted existing mutations; no optimistic second copy is introduced. Actual origin links are shown only when the checklist has a conversation origin. Active-row metadata uses the darker primary token, unchecked borders use the muted foreground, and hovered sidebar descriptions use the foreground for readable contrast.

Local evidence: 431 tests across 63 files, typecheck, lint and production build passed; independent object review passed 11 focused tests with no material findings. A synthetic local checklist was created through the authenticated application operation, then referenced by a browser-only chat fixture. A mobile notes edit saved revision 2; a concurrent real edit saved revision 3; the stale UI draft produced an explicit conflict without overwriting it. Reapply saved revision 4, checking a task updated both surfaces at revision 5, and archive/restore preserved history through revision 7. This is actual local object persistence combined with fixture-based chat presentation, not a new model/tool run. Desktop/mobile editing, 320px stacking, saved state and hover contrast have zero settled axe violations; semantic-heading findings were corrected. Screenshots include `screenshot-1791717371099.png` (inline/workbench), `screenshot-1791717422099.png` (real conflict), `screenshot-1791717428633.png` (history), `screenshot-1791717441767.png` (archive), `screenshot-1791717473003.png` (320px editor), `screenshot-1791717473591.png` (390px editor), and `screenshot-1791717474344.png` (shared revision after restore). All remain ignored local evidence. Hosted authenticated checklist presentation is not claimed for this slice.


F5 delivery: PR #38 merged as `86ba331`; production run `38135359671` passed, including the unauthenticated owner boundary. Authenticated hosted checklist presentation was not exercised for this visual slice.

### F6 — Mobile and final acceptance

The phone layout follows Paper's compact conversation header, expandable agent tools, labeled Browser/Terminal/Files/Apps/Activity tabs, and Agents/Chat/Workspace bottom navigation. More retains Objects, Memory, Code and Routines. The current feature instances remain mounted across responsive changes. Bottom navigation uses the existing draft and pending-operation fences; a restored unconfirmed save still permits opening Objects recovery. Moving from Workspace to Agents transfers focus to the sidebar; dismissing the workbench returns focus to its opener.

Safe-area insets and dynamic viewport height surround the app, with `viewport-fit=cover` and the supported content-resizing keyboard hint. Reduced-motion users get immediate transitions. Intentional adaptations: browser/OS status bars and the phone home indicator are not drawn inside the product; safe-area space comes from the browser. The private collection remains flat and unsupported annotation controls are omitted. Tool access uses the existing feature sheets. No fictional save, connection or progress state is introduced. Native iOS keyboard and physical-device safe-area behavior were not hardware-tested.

Local evidence: all 431 tests across 63 files, typecheck, lint and production build pass. Independent source review is clear and six focused conversation/object-recovery tests pass. Real browser interactions at 390×844, 320×568, 768×1024 and 1440×900 verify no horizontal overflow, chat draft retention through Workspace → Agents → same bot, modal focus transfer and Tab containment, compact-header tool expansion, settings-sheet retention across resizing, checklist draft retention across Escape/resizing, and visible Save/Cancel controls in the scrolled 320px editor. A synthetic unconfirmed create operation survived reload, kept unrelated navigation disabled, opened recovery from the bottom Workspace button, and was cancelled through the real local operation; the pending record cleared and navigation unlocked. Reduced-motion emulation reports the requested preference and 0.01ms transitions. Settled mobile chat, recovery, checklist editor, settings and desktop split-workbench axe audits have zero violations; modal focus guards and decorative initials require manual interpretation. Chat has zero incomplete checks.

Representative ignored screenshots: `screenshot-1791717674249.png` and `screenshot-1791717909874.png` (mobile chat), `screenshot-1791717680621.png` (mobile Files), `screenshot-1791717850132.png` (desktop shared checklist), `screenshot-1791717876965.png` (320px editor controls) and `screenshot-1791717897129.png` (restored mobile save recovery). Conversation presentation uses synthetic browser fixtures with inference and send routes blocked; checklist/file operations use the real local application. These checks do not claim a new hosted model run or authenticated hosted visual acceptance. The previous functional hosted acceptance remains in BUILD.md. Final CI, Cloudflare delivery and unauthenticated hosted access are verified on the release PR; no owner sign-in is required to finish this source/design scope.


F6 delivery and goal completion: PR #39 merged as `4f4fc66`; [production run 38135689129](https://github.com/cill-i-am/durable-pi/actions/runs/38135689129) passed checks, Alchemy deployment and the hosted authentication-boundary probes. A fresh unauthenticated mobile load at bot.cill-i-am.com served the new viewport configuration and stylesheet assets, fit the 390px viewport and passed the settled access-screen axe audit with zero violations and zero incomplete checks. An audit taken during the entrance fade reported transient contrast failures; the settled rerun passed. `screenshot-1791718295592.png` is the hosted access evidence. Authenticated hosted UI and physical iOS keyboard/safe-area testing remain unclaimed. F1–F6 are complete; subscription-only model connections and domain/runtime behavior remain intact.


### F7 — Correct navigation drift and audit the complete page

Reference: [complete Paper page](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-1-0/1-0), 40 artboards, token hash `30a00488`. All 40 JSX exports were retrieved into ignored local reference files. The shared frame, typography and component values come from those exports. The account menu uses the current Base UI [dashboard-01](https://ui.shadcn.com/blocks) composition.

Changes:

- The entire account row opens a menu with account security, archived agents and sign out. Desktop opens beside the row; mobile opens above it. The two separate footer icon buttons are removed.
- A 68px agent header contains identity, status, a short purpose and an overflow menu. Tool access, connections and skills remain mounted outside the menu; opening them refreshes their current state. Files and memory remain reachable there and through the workbench.
- Desktop starts with the Apps workbench. At 1440px its width is 664px; at 1024–1439px it contracts to leave a usable conversation column. Below 1024px it remains the same feature instance inside a modal sheet. Phones start in chat. The mobile heading uses a back action, Workspace label and agent identity.
- The empty workbench, Browser heading/address frame/handoff, Terminal command surface, Files toolbar/explorer/Markdown preview and source, Memory heading and creation sheet use the Paper composition. Recovery, tool permissions, receipts and actual model metadata remain authoritative.
- An unconfirmed checklist save remains reachable from the header even when other navigation is locked. The file explorer cannot shrink its list into a clipped row on smaller screens.

Complete page map (numbers are the artboard names in Paper):

| Screen | Implementation / disposition |
| --- | --- |
| 00 Design map | Reference, not an application route. |
| 01 Image treatment | Reference; implementation uses editable artboard exports. |
| 02 Complete agent window | `app/workspace`, `app/workbench`, `features/conversation`; shared frame corrected in F7. |
| 03 Workspace menu | `app/workspace-navigation`; account dropdown added in F7. |
| 04 Command palette | `app/workspace-navigation`; searches agents and supported commands. |
| 05 Sign in | `features/auth/login`, `auth-frame`; existing visual composition retained. |
| 06 First-time setup | Same auth frame and owner setup operation; error/pending state retained. |
| 07 Sign out / expired session | Better Auth returns to the sign-in screen. No unsupported claim that a composer draft survives sign-out. |
| 08 Create agent | `features/agents/agents`; right-hand creation sheet, purpose, identity preview and separate-memory explanation. |
| 09 Delegation | `features/activity/delegated-work`, `bot-tasks`; actual task status and results retained. |
| 10 Models and connections | Composer model defaults plus agent-menu connections/access; subscription-only controls and real capabilities retained. |
| 11 Fresh conversation | `features/conversation`, Apps welcome; shared split layout and empty-workbench direction. |
| 12 Working / thinking | `turn-reply`, `turn-activity`; actual streaming text, thinking and tool states. |
| 13 Steer / queue | Conversation composer and steering timeline; delivery states remain durable. |
| 14 Tool details | Expandable input/result rows and Activity records; original receipts unchanged. |
| 15 Image attachment | File picker, drag/drop, attachment cards and Files preview. |
| 16 Video preparation | Existing durable video status, frames and captions. Unsupported audio transcription is not advertised. |
| 17 Anchored asset steering | Whole-file context and app-element steering remain available; image-region pins are a product gap, not a styling claim. |
| 18 Approval | `features/access/approval-card`; only actual pending approvals expose decisions. |
| 19 Stop / retry | Existing cancellation and retry controls; completed effects are not presented as safe to repeat. |
| 20 Browser | Browser workbench: contextual title, framed address/captured page, internet settings and actual session state. |
| 21 Browser takeover | Handoff action moved beside the title. Owner controls remain fenced by screenshot version and authority generation. |
| 22 Terminal | Dark command/output surfaces, existing interactive session and transfer controls, network settings and recovery. |
| 23 Files | Compact toolbar, explorer, Markdown Preview/Source, context attachment, download and overflow actions. |
| 24 Apps | Existing inline/full app views, definition versions and durable responses; Apps remains a primary tab. |
| 25 Activity | Cross-agent timeline and task detail views retain real status, blocker and evidence records. |
| 26 Memory | Saved notes, archive search, tree and source view; private bot ownership retained. |
| 27 Connection / limits | Existing reconnect, unavailable-model, summary-recovery and run-recovery states. No invented reset time or auto-resume promise. |
| 28 Mobile conversation | Compact identity/header, readable chat and persistent bottom navigation. |
| 29 Mobile steering / attachments | Existing composer modes and attachment state in the mobile conversation. |
| 30 Mobile workbench | Back action, agent identity, five primary tabs, independently scrolling content and bottom navigation. |
| 31 Primitives / keyboard | shadcn/Base UI, Geist, semantic Paper tokens; design-system reference rather than route. |
| 32 Object exploration | Reference alternatives; selected design is 33. |
| 33 Live checklist | Existing inline object and Objects workbench; one authoritative object state. |
| 34 Conflict / recovery / history | Existing revision conflict, unconfirmed save, archive/restore and history. Recovery entry preserved in F7. |
| 35 Mobile checklist | Existing responsive task editor and history, with mobile workbench frame. |
| 36 Account security | Existing 720px security dialog, now reached from the account menu. |
| 37 Authenticator setup | Existing password, QR verification and recovery-code flow; sensitive data handling unchanged. |
| 38 Challenge / recovery / revoke | Existing challenge forms and session-revocation confirmation; auth behavior unchanged. |
| 39 Mobile account security | Existing full-height mobile security layout reached through the sidebar dropdown. |

Still intentional or functional differences: global search covers agents/commands rather than all file and conversation content; files are a flat collection; image-region annotations, manual memory-note editing and selectable agent appearances are not implemented. Model settings remain job-aware and subscription-only rather than reproducing the API-key provider controls in the mockup. The browser displays captured snapshots, not a live video stream. Existing app/data interactions, scope and recovery semantics take precedence over illustrative content. These are explicit product gaps/adaptations; this pass must not be reported as complete behavioral parity with all 40 mockups.

Local verification: 518 tests across 72 files, typecheck, lint (four pre-existing warnings, no errors), production build and the native workerd restart/replay suite pass. Browser checks at 1440×900, 1050×853, 390×844 and 320×568 cover the account menu, archived-agent filter, settings-sheet focus return, Tool access/Connections/Skills entry, Files Preview/Source, no horizontal page overflow, visible primary tabs at 1050px, and retained chat/terminal drafts across desktop/mobile transitions. A restored unconfirmed checklist save remains reachable from chat and from the workbench after resizing; unrelated workbench content is inert until recovery. Existing save/cancel semantics are unchanged.

Ignored screenshots: `/tmp/durable-pi-paper-desktop.jpg`, `/tmp/durable-pi-paper-account.jpg`, `/tmp/durable-pi-paper-mobile.jpg`. Visual fixtures use production React components with synthetic API responses and blocked mutations. They establish UI behavior, not provider execution. Existing deterministic tests cover unchanged auth, working-object and run lifecycles. This pass does not claim freshly executed hosted journeys for every artboard. [PR #49](https://github.com/cill-i-am/durable-pi/pull/49) merged to main `e23121a`. [Production run 38149392785](https://github.com/cill-i-am/durable-pi/actions/runs/38149392785) passed checks, Alchemy deployment and hosted authentication probes. Authenticated hosted inspection confirmed the account dropdown, security entry, compact agent header, primary workbench tabs and Browser/Terminal internet-settings entry. The Personal assistant returns the new terminal policy. An older verification bot initially returned the previous response shape; the UI now explains missing policy data and keeps the setting disabled until supplied, rather than assuming a policy. Cloudflare documents a [mixed-version window during code updates](https://developers.cloudflare.com/durable-objects/platform/known-issues/#code-updates). This is consistent with the observed difference, not proof of its underlying cause.

The synthetic production-binding network check passed browser unrestricted/restricted/isolation and terminal off/on/off. It made no model requests or personal-bot permission changes. Its bots were archived and temporary verifier deleted. This verifies the hosting adapters separately from the local UI fixtures; it does not claim a new end-to-end model conversation for every Paper state.

### Login annotation follow-up

The owner’s later browser annotations override the original login artboard copy: remove the privacy tagline, ChatGPT-connection footer/divider and Pi wordmark text. Keep the mascot and layout. The shared password eye now plays Meal Planner’s short activation click, with a remembered mute control in the auth header and account menu. Locally checked desktop, 390 px and 320 px layouts, keyboard access, native audio creation, muted playback, persistence and optional-audio/storage failure handling. Hosted release evidence belongs to the delivery PR.


### F8 — Settings, interiors and conversation density

Implementation and local comparison complete. [PR #52](https://github.com/cill-i-am/durable-pi/pull/52) records release and hosted verification. References use the original Paper page plus the explicitly requested updates, at 1440×900, 390×844 and a 320px stress viewport.

Carry owner annotations into Paper: account dropdown, removed login wordmark and helper copy, remembered interaction sound, subscription-only models, and public-internet controls for Browser and Linux Terminal. These changes amend the reference; unsupported image-region pins, file folders and global content search remain explicit product gaps.

Delivery evidence will distinguish local synthetic visual fixtures, deterministic/native checks and authenticated hosted checks. No backend authority, durable record, model connection or execution policy changes are intended.


#### F8 screen comparison and behavior checks

| Screen / Paper reference | Result of this pass |
| --- | --- |
| Settings · 10 | One settings workspace with category navigation and a 664px detail column at 1440px. Existing model, permission, connection and skill operations remain in their feature slices. Mobile switches between categories and detail. Model defaults remain job-aware; only the subscription connection is offered. |
| Account menu · 03 | Settings, archived agents and sign-out. The owner’s follow-up moves Account security and Interaction sounds into Settings → General, retaining Test sound. Paper’s menu and General description reflect this change; the separate Account category is removed. |
| Login / setup · 05–06 | Paper now reflects the previously shipped copy removals and sound control. Visible Pi wordmark, privacy tagline and ChatGPT-login footer are removed. Password-eye click and remembered mute are annotated. |
| Browser / takeover · 20–21 | Smaller capture heading, one visible address, secondary page text/links and captured-snapshot status. Current URL remains visible in the address field. Existing control ownership and command versions remain unchanged. Paper's live multi-tab browser and region selection remain separate capability gaps. |
| Terminal · 22 | Compact workspace/network row, smaller labels and collapsed checkpoint explanation. Network settings hide the main terminal presentation without unmounting it. Draft command survives opening/cancelling the form. Actual command/interactive modes remain; Paper's multiple named sessions are not simulated. |
| Files · 23 | One Files/Trash title menu, outline Upload action, 156px explorer and compact preview/source controls. Mobile stacks the explorer. Preview, Source and narrow-screen overflow checked. |
| Apps · 24 | One toolbar for back, title, publication state, version and refresh; bordered 14px app canvas and quieter app list. Loading/failure retains All apps. Generated content remains actual typed app content, not the illustrative itinerary. |
| Activity · 25 | Heading and agent scope share a row; filters and task details share the next row. Flat timeline, single-line times, durable status/evidence unchanged. |
| Memory · 26 | Search moves above the tabs and opens History results. Note cards retain their source disclosure. Original-message lookup checked. Manual note editing remains a capability gap rather than a fake control. |
| Checklists · 33–35 | Progress and revision share a row; recovery/conflict alerts keep full width. Existing task editor, history, access isolation and pending-operation recovery retain their owners. Desktop/mobile presentation inspected; no persistence changes. |
| Chat · 11–14, 28 | Tighter text rhythm, subdued timestamps, smaller thinking control and compact model profile. Steer/Queue moves into the send-action menu, matching Paper; stop remains directly available. Verified both delivery selections, expanded thinking/tool detail and 320px bounds. |
| Browser / Terminal internet settings · new 40–41 | Paper now documents separate per-bot unrestricted settings, retained tool permissions and the terminal-session save/stop rule. Existing settings APIs and generation/revision checks are unchanged. |

Behavior checks use the production React components with isolated synthetic fetch/EventSource fixtures. Confirmed model saves clear the draft warning; failed saves retain the draft and show the error. Category changes, close and Escape cannot discard model, connection or skill drafts. Cancel unlocks navigation. A chat draft survives settings; a terminal command draft survives opening/cancelling internet settings. Settings fields fit 320px. File Source and Memory source/history retrieval display fixture originals. Restored unconfirmed checklist saves remain reachable on mobile with unrelated navigation locked. An app-load failure retains its back action. These presentation fixtures are not evidence of new external actions or model runs.

Visual evidence is local and ignored under `.research/interiors-evidence/`: `settings-desktop.png`, `files-mobile.png`, `chat-working-mobile.png`, and `recovery-mobile.png`. Each was compared with the corresponding Paper state; the design source and implementation evidence remain distinct. Paper account/menu/settings/login updates were checked for type, alignment, spacing, contrast and clipping. They do not erase the outstanding capability gaps in the earlier 40-screen inventory.

Local verification: 518 tests / 72 files, TypeScript, native workerd loop/restart/replay recovery and production build pass. Lint has four existing warnings and no errors. Final UI-only changes are rechecked before signing; CI repeats the complete suite at the PR commit. No backend, permission, receipt, archive, planning or execution policy changes were made.

Production-build regression check: the first deployment passed its pipeline and authentication probes, but authenticated visual inspection caught the settings panel shifted off-screen. CSS minification combined the custom `translate: none` into `transform`, leaving the primitive's independent translation utility active. Settings now uses the native `translate-none` class so class merging removes the centering utilities. A second finding involved resizing while settings covered a workbench: the mobile workbench became modal and hid Settings from assistive technology. The workbench now stays non-modal until Settings closes. Production-built CSS checks cover desktop bounds, mobile full-screen bounds, accessible Back/Close controls, return to the workbench and preservation of a command draft across resizing. These are presentation fixes; they do not alter tool permissions or execution.
