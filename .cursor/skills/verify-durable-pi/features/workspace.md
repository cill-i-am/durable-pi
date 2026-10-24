# Workspace and navigation

Find an agent, move between chat and saved work, and reopen the same view from a readable URL.

## Sub-features

- `workspace-collection`: Browse and search your active agents; inspect archived agents separately.
- `workspace-pages`: Open Browser, Terminal, Files, Apps, Activity, Checklists, Memory, Code, and Routines.
- `workspace-settings`: Open personal Account, Preferences, Account security, connection/skill libraries, Channels, Family and Model access; keep agent identity/email, model defaults, tool assignments, policies and skill pins with their agent.
- `workspace-settings-stack`: On mobile, retain each settings parent beneath its native drawer; return one level with Back, Escape, swipe or the leaf close button, and restore focus to the originating control.
- `workspace-responsive`: Use desktop panels or mobile navigation without losing the conversation draft.
- `workspace-appearance`: Choose appearance and interaction-sound preferences.
- `workspace-links`: Preserve the selected resource, tab, and supported filters in the URL.

- `workspace-update`: Detect another build and offer a persistent explicit Reload action.
- `workspace-asset-recovery`: Recover a retired lazy-loaded screen without unmounting the conversation.
- `workspace-reload-fences`: Wait for open edits, saves, uploads, recordings, or an interactive terminal before reloading.

## How to get to it (user POV)

- Open `/agents`, `/agents/archived`, or an agent's `/agents/AGENT_SLUG` page.
- Use the agent sidebar, agent search, or Cmd/Ctrl+K. Use **Tools** or the **Workbench tool** selector for saved work.
- Open Settings from the account menu at `/settings`, then choose Account, Preferences, Account security, Connections, Skills, Channels, Family or Model access. Personal detail URLs use `/settings/account`, `/settings/preferences`, `/settings/security`, `/settings/connections` and `/settings/skills`; Channels uses `/settings/channels`, Family `/family` and shared Model access `/family/model-access`. Connections and Skills here are personal libraries shared across your own agents. Channels contains the owner's account-wide WhatsApp routing.
- Agent settings start at `/agents/AGENT_SLUG/settings`. Its sections use `/agents/AGENT_SLUG/settings/SECTION`: General for identity/instructions and email, Models for job defaults, Connections for tool assignments, Tool access for policies, and Skills for pinned revisions.
- On mobile, the settings list remains beneath each detail drawer. Family → Model access and agent Models → Model access retain their originating page. A leaf's close button returns one level; **Close settings** on the root returns to the original chat or workbench. Desktop uses the existing two panes.
- Memory, Files and Checklists remain workbench resources; there is no `/agents/AGENT_SLUG/settings/memory` page. Removed URLs return 404. Global sheets retain a validated assistant/workbench `returnTo` backdrop without making that agent the owner of personal settings.
- On a narrow screen, use Agents, Chat, and Workspace navigation.

## Driving it with the verification harness

Preconditions: Use the disposable browser fixture or a signed-in account. Substitute an actual agent slug for `AGENT_SLUG`.

- **Open an agent.** In Playwright, open `/agents`, sign in, and select the **Navi** link in **Your agents**. The fixture reaches `/agents/navi` and enables **Message Navi**.
- **Reopen a view.** Run `pnpm test:browser tests/browser/agent-slugs.spec.ts --project=desktop`. The test opens settings and Files directly, checks canonical links, and retains the Trash query.
- **Check mobile.** Run the same spec with `--project=mobile`. The view must fit the viewport and resolve the same agent.
- **Global ownership.** Run `pnpm test:browser tests/browser/route-ownership.spec.ts` for global URLs, removed-route rejection, draft/file and mounted-composer preservation, safe return locations, browser history and nested mobile sheets.
- **Mobile settings stack.** Run `./node_modules/.bin/playwright test tests/browser/settings-stack.spec.ts tests/browser/model-access-pending.spec.ts --project=mobile --trace on --output /private/tmp/pi-settings-stack-evidence`. Check retained parent element identity, focus restoration, native downward touch dismissal, agent-to-global history and reload, pending-edit dismissal guards, a dirty form across portrait/landscape resizing, and outgoing body retention through native close and browser Back. The gesture test uses Chromium's touch input; it does not dispatch a synthetic close event. The same-document deep-link check uses native browser history without fabricating the app's stack state.
- **Inspect other panels.** On the real app, open each mapped panel through **Workbench tool**, reload, and confirm the selected panel remains visible. The fixture does not supply every panel's data.
- **Proof.** Keep the trace and URL before and after navigation; a screenshot alone does not establish draft or route preservation.

- **Stale tab.** Run `pnpm test:browser tests/browser/stale-tab.spec.ts` for update, missing-chunk, draft, upload, storage, and uncertain-send recovery on desktop/mobile. Run `pnpm test:client-upgrade` for two distinct builds and an actually retired asset; verify the new entry bundle, preserved draft/file, and zero submissions.

## Gotchas

- Cmd/Ctrl+K searches agents and navigation commands. Conversation-content search is in Memory.
- The visible label **Checklists** uses the path segment `objects`.
- Preferences are browser/device-scoped. Personal libraries do not become shared family resources, and opening a settings route never selects tools or grants permission. Existing family-admission checks remain in force.
- Settings route history retains validated parent routes in native navigation state. A direct leaf reconstructs its canonical settings parents; `settingsView` is not a navigation contract. Browser Back/Forward and reload must preserve the actual stack without substituting another assistant.
- An update offers an explicit Reload action. A failed import offers Reload page; ordinary route failures retain Try again. Detection does not automatically reload or resubmit work. Offline state or unresolved local work disables reload.
