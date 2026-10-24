# Reusable instructions and skill revisions

Keep reusable Markdown instructions in a private library and choose explicit revisions for each agent.

## Sub-features

- `skills-library`: Create, edit, import Markdown, inspect history, archive, and restore skills.
- `skills-pin`: Select up to four immutable revisions for an agent.
- `skills-update`: Offer a newer revision without silently changing existing selections or active work.
- `skills-conflict`: Preserve drafts through stale edits and unconfirmed saves.
- `skills-executor`: Preview and copy a provider skill through an authorized Executor connection.

## How to get to it (user POV)

- Open personal **Settings → Skills** at `/settings/skills` for the library. Use library/archive tabs, new-skill controls, or **Import skill Markdown**.
- Use **Import from Executor**, choose the provider/app, preview its main SKILL.md, and save a local revision.
- Open agent **Skills** at `/agents/AGENT_SLUG/settings/skills` to select revisions for that agent; use the visible update control when a newer revision exists. Library authoring/history and per-agent pins are separate screens.

## Driving it with the verification harness

Preconditions: Use a disposable Markdown skill. Executor import requires workspace authorization and a connected provider.

- **Library journey.** In personal Skills, create `Feature map writing`, fill Name and Instructions, and save. Open the agent's Skills screen and select that revision. Edit the personal library copy and verify the agent still pins the earlier revision until updated.
- **Reopen and recover.** Reload settings, inspect history, and restore a previous revision as a new version. Exercise a stale edit from a second view only in a disposable skill.
- **Import.** Import a Markdown file, inspect its saved content, then archive and restore it. For Executor, compare the previewed main document with the saved revision.
- **Checks.** Run `pnpm test tests/skills.test.ts tests/skill-import.test.ts`.
- **Proof.** Capture selected revision, library head, and the agent's actual subsequent tool/use behavior separately.

## Gotchas

- Imported instructions do not grant tool permissions.
- Provider import copies the main SKILL.md, not all referenced files. Accessing provider references still needs the appropriate connected tool.
- Saved copies remain after disconnect. A running request retains its admitted skill selection.
- The library is personal/account-wide, not family-shared; each agent's selected revisions are explicit. Opening or editing the library does not assign its skills to an agent.
