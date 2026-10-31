# Conversation-first redesign

User goal: redesign every existing surface in Paper first, then implement it; replace the previous UI, preserve product behaviour and privacy, and verify the result.

## Design contract

- Paper file: `01M4GJ8G5KNDADJRVDDC3PQ6CT`. Approved conversation/workbench page: `p-C-1`. Canonical dock: `1DHK-1`; main shell `1ATY-1`; mobile stack `1BS3-1`; recovery `1FDX-0`.
- Read the current JSX, computed styles and screenshots from Paper. Screenshots are comparison evidence, not a substitute for extracting values.
- For each page, read the relevant UI skills through Executor `personal-skills` and apply https://jakub.kr/writing/less-is-more: keep necessary information and task clarity; remove duplicate navigation, gratuitous copy, eyebrows and unnecessary motion.
- Reuse `@workspace/ui`, shadcn/Base UI conventions and semantic Tailwind tokens. Geist; white content, neutral inset frame, restrained purple primary; compact controls, textured buttons and quiet card depth. No parallel app theme or duplicated primitive implementation.
- One collapsible sidebar, conversation first, compact decision dock above composer. Queue expands on demand. Mobile uses stacked bottom drawers. Workbench uses openable/closable browser-like tabs with an expansion control.
- Existing chats remain private per assistant. Do not display other family members as chat participants or imply invitations grant chat access. Show actual current user and assistant. No invented calendar integration or multiplayer backend.
- Preserve canonical settings scopes: account/security/preferences/connections/skill library/channels/family are global; only assistant-owned configuration goes beneath an assistant route.
- Preserve existing capabilities, authoritative ownership, draft recovery, errors, keyboard/focus paths and Effect/XState lifecycles. A visual redesign does not authorize competing state stores, mocked production data or external mutations.
- Paper review precedes code edits for every new surface. The existing approved conversation/workbench designs satisfy this gate for that shared shell. Other surfaces get dedicated, labelled designs first.

## Surface inventory and ownership

Status is recorded separately for Paper, code and verification. A shared component change does not by itself prove a page.

| Area | Existing surfaces | Paper | Implementation | Verification |
| --- | --- | --- | --- | --- |
| Shell | Expanded/collapsed sidebar, family/account menus, command search, startup, not found and route recovery | Designed p-C-1 + shell states | Implemented | Focused checks; final integration underway |
| Conversation | Empty/history/search, messages, composer, attachments, queued/steered/stopped/recovered turns, inline rich results, actual participants | Designed p-C-1 + empty/recovery states | Implemented | 45 units; 20 browser flows passed |
| Decisions | Pending/expanded/detail, allow/deny/future permission, saving/accepted/running/completed, uncertainty/recovery, defer | Approved p-C-1 | Implemented | 33 units; dock + 10 integration flows passed |
| Workbench frame | Open/close/add/select tabs, expanded/return, mobile stack, retained state and locks | Approved p-C-1 | Implemented | 12 units; desktop/mobile native regression passed |
| Assistants | Active/archived collection, create/edit/archive, catalog loading/unavailable | 23-board entry/management set p-E-0 | Implemented | 48 units; 46 entry/management browser flows passed |
| Auth | Sign in/setup, passkey sign-in, forgot/reset password, two-factor, invitation join/expired/unavailable, access ended | Designed p-E-0 | Implemented | Desktop/mobile journeys; built-site passkey check passed |
| Global settings | Root, account/photo, preferences, security/password/passkeys/factors/sessions, connections library, skills library/import, channels/email/WhatsApp | 16-board settings set p-D-0 | Implemented | 119 units; 22 mobile/16 desktop settings cases passed |
| Family | Members/invitations/invite/revoke/remove, family model access and non-admin states | Designed p-D-0 + entry p-E-0 | Implemented | Family/identity/recovery flows passed |
| Assistant settings | General, model configuration, tool access, attached skills, attached connections | Designed p-D-0 | Implemented | Scoped routes, stacks, drafts and locks verified |
| Files | Browse/search, selection/detail/preview/media, upload/extraction/recovery, trash/restore | Designed p-F-0 | Implemented | Focused + latest-source preview recovery passed |
| Memory | Notes/history/tree/search, summaries/query/export/import/recovery (no note editor exists) | Designed p-F-0 | Implemented | Focused checks passed |
| Checklists | List/detail, tasks, edit/save/recovery | Designed p-F-0 | Implemented | Focused + latest-source conflict/recovery passed |
| Apps | App list, generated UI/web canvas, version preview, interactive forms and failures | Designed p-F-0 | Implemented; retained draft proof | Focused desktop/mobile checks passed |
| Browser | Session/page, address/navigation, control/results, unavailable/recovery | Designed p-G-0 | Implemented | Execution-tool checks passed |
| Terminal | Commands, interactive session, transfers, stop/recovery | Designed p-G-0 | Implemented | Execution-tool checks; retained-owner fence verified |
| Code | Execution list/detail, submit/run/stop/recovery | Designed p-G-0 | Implemented | Execution-tool checks passed |
| Routines | List, editor/schedule, webhook, history/run/detail/recovery | Designed p-G-0 | Implemented | 90 tool units; 43 browser cases incl mobile race passed |
| Activity | Timeline/filter/search, task list/detail, controls/recovery | Designed p-G-0 | Implemented | Execution-tool checks passed |
| Inline answers | Answer gallery, structured questions, Weather/Places/Route/Products/Calculation/DataTable/Comparison results | 9-board / 12-renderer set p-I-0 | Implemented | 86 units, 14 browser cases; final combined pass underway |
| Shared feedback | Loading/empty/error, stale/update/reload recovery, toasts, responsive overlays | UI primitives + shell recovery p-C-1 | Implemented | Class/contrast + built-site upgrade recovery checks underway |

## Working boundaries

- Branch: `codex/conversation-first-redesign`, based on verified remote main `b426e6928b5d7fecf787d8e4eac9a9bfaa85e7f3`.
- Worktree: `/Users/cillianbarron/.codex/worktrees/route-ownership/durable-pi`.
- Use installed versions and `@xstate/effect` with an owned Effect scope. Read `docs/decisions/xstate-effect-state-machines.md` before changing lifecycle control.
- Local pnpm is 12.15.0; run commands with `npm_config_manage_package_manager_versions=false` to avoid automatic download of the package.json launcher version. Keep the lockfile and package manager conventions. `verifyDepsBeforeRun: error` prevents verification from silently reinstalling tools; restore the frozen lockfile explicitly after dependency edits.
- Verification uses the existing provider-free browser fixture in `scripts/performance/server.mjs`, actual application builds, behavioural tests, and repository gates. Never send a real message, invitation, approval or provider command as a UI smoke test.
- Preserve the distinction between designed, implemented, locally verified, CI-passed, merged, deployed and production-verified. No delivery state is implied by the preceding one.

## Per-page evidence

Each owner adds its route/surface list, Executor skills read, Paper page/artboard links, design-before-code confirmation, implementation files and checks here when handing back. No page is complete with only a theme change or only a Paper screenshot.

Evidence is split by owning surface: [shell](design-evidence-shell.md), [foundations](design-evidence-foundations.md), [conversation](design-evidence-conversation.md), [decisions](design-evidence-decisions.md), [workbench](design-evidence-workbench.md), [auth and assistants](design-evidence-auth-agents.md), [settings](design-evidence-settings.md), [resources](design-evidence-resources.md), [execution tools](design-evidence-execution-tools.md), and [inline answers](design-evidence-answers.md).
