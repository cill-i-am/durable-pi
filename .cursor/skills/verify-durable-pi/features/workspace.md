# Workspace and navigation

Find an agent, move between chat and saved work, and reopen the same view from a readable URL.

## Sub-features

- `workspace-collection`: Browse and search your active agents; inspect archived agents separately.
- `workspace-pages`: Open Browser, Terminal, Files, Apps, Activity, Checklists, Memory, Code, and Routines.
- `workspace-settings`: Open General, Models & connections, Agents & tools, Skills, Family, Model access, and Memory & data.
- `workspace-responsive`: Use desktop panels or mobile navigation without losing the conversation draft.
- `workspace-appearance`: Choose appearance and interaction-sound preferences.
- `workspace-links`: Preserve the selected resource, tab, and supported filters in the URL.

- `workspace-update`: Detect another build and offer a persistent explicit Reload action.
- `workspace-asset-recovery`: Recover a retired lazy-loaded screen without unmounting the conversation.
- `workspace-reload-fences`: Wait for open edits, saves, uploads, recordings, or an interactive terminal before reloading.

## How to get to it (user POV)

- Open `/agents`, `/agents/archived`, or an agent's `/agents/AGENT_SLUG` page.
- Use the agent sidebar, agent search, or Cmd/Ctrl+K. Use **Tools** or the **Workbench tool** selector for saved work.
- Open Settings from the agent controls. Assistant settings use `/agents/AGENT_SLUG/settings/SECTION`; Family, shared Model access and Account security use `/family`, `/family/model-access` and `/settings/security`. Removed URLs return 404. Global sheets retain a validated assistant/workbench `returnTo` backdrop.
- On a narrow screen, use Agents, Chat, and Workspace navigation.

## Driving it with the verification harness

Preconditions: Use the disposable browser fixture or a signed-in account. Substitute an actual agent slug for `AGENT_SLUG`.

- **Open an agent.** In Playwright, open `/agents`, sign in, and select the **Navi** link in **Your agents**. The fixture reaches `/agents/navi` and enables **Message Navi**.
- **Reopen a view.** Run `pnpm test:browser tests/browser/agent-slugs.spec.ts --project=desktop`. The test opens settings and Files directly, checks canonical links, and retains the Trash query.
- **Check mobile.** Run the same spec with `--project=mobile`. The view must fit the viewport and resolve the same agent.
- **Global ownership.** Run `pnpm test:browser tests/browser/route-ownership.spec.ts` for global URLs, removed-route rejection, draft/file and mounted-composer preservation, safe return locations, browser history and nested mobile sheets.
- **Inspect other panels.** On the real app, open each mapped panel through **Workbench tool**, reload, and confirm the selected panel remains visible. The fixture does not supply every panel's data.
- **Proof.** Keep the trace and URL before and after navigation; a screenshot alone does not establish draft or route preservation.

- **Stale tab.** Run `pnpm test:browser tests/browser/stale-tab.spec.ts` for update, missing-chunk, draft, upload, storage, and uncertain-send recovery on desktop/mobile. Run `pnpm test:client-upgrade` for two distinct builds and an actually retired asset; verify the new entry bundle, preserved draft/file, and zero submissions.

## Gotchas

- Cmd/Ctrl+K searches agents and navigation commands. Conversation-content search is in Memory.
- The visible label **Checklists** uses the path segment `objects`.
- An update offers an explicit Reload action. A failed import offers Reload page; ordinary route failures retain Try again. Detection does not automatically reload or resubmit work. Offline state or unresolved local work disables reload.
