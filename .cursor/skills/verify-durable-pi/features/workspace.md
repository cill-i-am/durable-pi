# Workspace and navigation

Find an agent, move between chat and saved work, and reopen the same view from a readable URL.

## Sub-features

- `workspace-collection`: Browse and search your active agents; inspect archived agents separately.
- `workspace-pages`: Open Browser, Terminal, Files, Apps, Activity, Checklists, Memory, Code, and Routines.
- `workspace-settings`: Open General, Models & connections, Agents & tools, Skills, Family, Model access, and Memory & data.
- `workspace-responsive`: Use desktop panels or mobile navigation without losing the conversation draft.
- `workspace-appearance`: Choose appearance and interaction-sound preferences.
- `workspace-links`: Preserve the selected resource, tab, and supported filters in the URL.

## How to get to it (user POV)

- Open `/agents`, `/agents/archived`, or an agent's `/agents/AGENT_SLUG` page.
- Use the agent sidebar, agent search, or Cmd/Ctrl+K. Use the workbench shortcuts or the **Workbench tool** selector for saved work.
- Open Settings from the agent controls. Direct settings links use `/agents/AGENT_SLUG/settings/SECTION`.
- On a narrow screen, use Agents, Chat, and Workspace navigation.

## Driving it with the verification harness

Preconditions: Use the disposable browser fixture or a signed-in account. Substitute an actual agent slug for `AGENT_SLUG`.

- **Open an agent.** In Playwright, open `/agents`, sign in, and select the **Navi** link in **Your agents**. The fixture reaches `/agents/navi` and enables **Message Navi**.
- **Reopen a view.** Run `pnpm test:browser tests/browser/agent-slugs.spec.ts --project=desktop`. The test opens settings and Files directly, checks canonical links, and retains the Trash query.
- **Check mobile.** Run the same spec with `--project=mobile`. The view must fit the viewport and resolve the same agent.
- **Inspect other panels.** On the real app, open each mapped panel through **Workbench tool**, reload, and confirm the selected panel remains visible. The fixture does not supply every panel's data.
- **Proof.** Keep the trace and URL before and after navigation; a screenshot alone does not establish draft or route preservation.

## Gotchas

- Cmd/Ctrl+K searches agents and navigation commands. Conversation-content search is in Memory.
- The visible label **Checklists** uses the path segment `objects`.
- A stale tab can fail to load a removed lazy-loaded chunk after a deployment. A full reload is the recorded workaround; automatic recovery is not mapped as implemented.
