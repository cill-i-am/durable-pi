# Workspace navigation

TanStack Start’s file routes own page and resource identity. `src/navigation/workspace.ts` owns the Effect Schema contracts and typed destinations; `src/app/use-workspace-location.ts` adapts those destinations to the router. Features receive controlled selections and report changes to this boundary. They do not maintain a second selected resource in local storage.

The workspace reads pathname, parameters and validated search together from the committed leaf match. The router publishes its pending location before committing matches; mixing those phases can briefly select a different assistant or close a workbench during navigation.

| Screen                   | Path                                 |
| ------------------------ | ------------------------------------ |
| Active agents            | `/agents`                            |
| Archived agents          | `/agents/archived`                   |
| Create an agent          | `/agents/new`                        |
| Agent conversation       | `/agents/$agentId`                   |
| Edit an agent            | `/agents/$agentId/edit`              |
| Workbench screen         | `/agents/$agentId/$panel`            |
| Saved workbench resource | `/agents/$agentId/$panel/$itemId`    |
| Assistant settings       | `/agents/$agentId/settings/$section` |
| Account security         | `/settings/security`                 |
| Family                   | `/family`                            |
| Shared model access      | `/family/model-access`               |

Panels are Browser, Terminal, Files, Apps, Activity, Checklists, Memory, Code and Routines. A selected app, file, checklist, command, execution result, routine, plan or activity record belongs in the resource path. Browser and Memory currently have no independent saved-detail screen. Source disclosure and tree expansion inside Memory remain local interactions.

`/` is a bootstrap location that replaces itself with the last owned active agent. Assistant-scoped Family, Model access and Security URLs and the implicit settings index are removed; they return 404 without redirects. A valid unknown bot or missing resource remains unavailable at its requested location; it does not substitute another bot. Opening a link to an archived agent replaces that location with `/agents/archived`. Restore is a separate operation.

This route refactor retains the current settings dialog, nested security dialog, mobile bottom sheets and visual components. General, Models, Connections, Skills, Access and Memory remain assistant-scoped: their existing screens include assistant configuration or assignments. Separating the shared controls within those mixed screens belongs to the later UI refactor.

## Search state

Use validated query parameters for tabs, the `q` agent filter, file `preview=source`, Memory’s `query`, and Activity’s `scope`, `filter`, `cursor`, and task `offset`. Settings can retain `panel` and `item` as the underlying workbench view, and `settingsView=sections` selects its mobile section list. Editor and authentication routes use a validated `returnTo`.

Global settings accept `settingsView` and an optional `returnTo` containing a validated assistant conversation or resource URL. This records the overlay backdrop, not the owner of the global setting. The same assistant ID key, conversation, draft, file selection and workbench stay mounted; closing restores the backdrop. Same-origin validation strips action parameters and rejects fragments, API URLs, nested overlays and editor URLs. A direct global link uses the last active assistant as its backdrop. An explicit unknown or archived backdrop remains unavailable while the global settings themselves stay accessible. Authentication return URLs accept these global destinations under the same restrictions.

Resource identity in a workbench path cannot be overridden by query parameters. View state must belong to its panel. Use TanStack’s search codec for structured cursors and strings that resemble JSON. Query typing is generated from the file routes. Editing filters replaces the history entry; changing a screen or selected resource creates an entry.

Use `workspaceDestination` with native TanStack `Link` for ordinary navigation. Use the location hook for guarded feature commands, such as selecting a newly confirmed save. Normal links and browser history pass through the shared `useBlocker`; pending operations and unsaved edits cannot be abandoned. The pathless workspace layout keeps the same bot’s conversation and draft mounted while its screens change. Switching bots changes the conversation owner.

Menus, attachment pickers, disclosure panels and archive confirmations remain transient. Navigation never confirms a mutation or grants tool access. A link is shareable as navigation, while the server still requires the owner’s authenticated session and enforces bot/resource ownership. Reset credentials remain in their existing private fragment flow and are excluded from workspace return URLs.

Confirming an archive keeps the current view and its query parameters. If the archived agent is open, the workspace replaces its location with Home before refreshing the agent list. Both collections offer a direct Home link and render as standalone management lists, without workspace commands, an agent sidebar, or a workbench. Active agents have an Archive action on the right (except Home); archived agents have Restore and do not link to a workspace.

Selecting an active agent from command search opens its conversation, including when that agent already has a workbench open.

## Overlay ownership

Base UI owns drawer lifecycle, gestures and focus. When Settings opens above the workbench, the workbench yields modal focus ownership. When Security opens, Settings yields it to Security. This prevents a parent from hiding its child when the viewport crosses the mobile breakpoint. The single primitive tree retains its mounted content.

## References and verification

Follow [TanStack file-based routing](https://tanstack.com/router/latest/docs/routing/file-based-routing), [search parameters](https://tanstack.com/router/latest/docs/guide/search-params), and [navigation blocking](https://tanstack.com/router/latest/docs/guide/navigation-blocking). `tests/workspace-url.test.ts` covers Schema validation, auth return sanitization, native matching and memory-history restoration. Local browser checks cover the actual route components, reloads, Back/Forward, dirty guards and mobile nesting. Hosted release evidence belongs in BUILD.md.

The desktop tool picker opens below its trigger to keep its first choices visible. Local browser audits use actual route definitions and components with synthetic API responses; they verify navigation, not live provider operations or deployment. `tests/workspace-navigation.test.tsx` and `tests/agent-collection.test.tsx` enforce the management-list boundary, archive/restore actions, and returning to the current agent's conversation.

The [XState–Effect skill PR](https://github.com/cill-i-am/skills/pull/12) was read for this work. Its selection rule applies: keep routing and overlay lifecycle with their existing owners rather than introduce a competing machine. No XState package was added or upgraded. For a future workflow that benefits from a statechart, use the official Effect integration and verify its installed version first.
