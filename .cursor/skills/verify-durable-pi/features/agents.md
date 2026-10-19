# Persistent agents and readable links

Create named assistants with their own instructions and saved work, and reach them through stable human-readable links.

## Sub-features

- `agents-create`: Create an agent with a name and instructions.
- `agents-edit`: Rename or edit instructions without replacing its saved conversation.
- `agents-slug`: Resolve ID or slug links and show the canonical slug URL.
- `agents-archive`: Archive an agent, reject new work, and restore its existing data.
- `agents-private`: Keep each agent's files, memory, objects, apps, and routines distinct.
- `agents-defaults`: Give new agents configured email and the account's available Executor defaults.

## How to get to it (user POV)

- Use **Your agents**, the agent sidebar, or `/agents/new`.
- Open `/agents/AGENT_SLUG/edit` for an existing agent. Browse `/agents/archived` to restore it.
- Follow `/agents/AGENT_ID` or `/agents/AGENT_SLUG`; nested workbench and settings paths accept either reference.
- Agent configuration is in its Settings. Defaults still require their deployment or connection prerequisites.

## Driving it with the verification harness

Preconditions: Use an isolated account for creation/archive tests. The fixture has agent ID `home` and slug `navi`.

- **Canonical links.** Run `pnpm test:browser tests/browser/agent-slugs.spec.ts`. `/agents/home/settings/general` becomes `/agents/navi/settings/general`; the selected Files tab survives replacement.
- **Create and reopen.** On the real app, create `Feature map assistant`, return to the collection, and reopen it. Record its ID and slug through visible links.
- **Rename.** Change its name, reload its original slug link, and confirm the new name with the same saved history.
- **Archive and restore.** Archive only the test agent, verify it leaves the active collection, then restore it from Archived. Its prior content must remain.
- **Proof.** Capture collection, canonical URL, and reopened content. Confirm the new agent's email/default tools separately instead of inferring them from creation.

## Gotchas

- Slugs derive from the initial name and stay stable after rename. Collisions receive suffixes; archived slugs remain reserved.
- Stable IDs remain the underlying identity and appear in exact task handles.
- Archive acknowledgement blocks new admission; work already admitted can still settle.
- Named-agent task controls span the same account. They do not grant access to another family member's agents.
