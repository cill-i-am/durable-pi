# Memory, retrieval, and backups

Find original conversation records, inspect summaries and sourced notes, and export or recover the agent's saved memory.

## Sub-features

- `memory-search`: Search exact text and retrieve original ranges or dates.
- `memory-summaries`: Inspect the summary tree down to source messages and recover failed summary work.
- `memory-notes`: Read sourced Markdown notes and revision history maintained by the agent.
- `memory-import`: Import dated history without running it as a new instruction.
- `memory-export`: Download private HTML or JSONL exports.
- `memory-backup`: Inspect the last complete backup and validate a restore into a new local database.

## How to get to it (user POV)

- Open `/agents/AGENT_SLUG/memory`, or **Settings → Memory & data**.
- Use **Search memory** and the Notes, History, Tree, and Files tabs.
- Ask the agent to use `search_memory`, `zoom`, or `date` to retrieve originals, or maintain a sourced note.
- In Files within Memory, use **Download your memory**, **Cloud backup**, and **Import older history**.

## Driving it with the verification harness

Preconditions: Seed a distinct test sentence through an ordinary conversation. Keep exports private.

- **Find an original.** Open Memory, fill **Search conversation history…**, and select **Search memory**. Open the matching record and confirm the exact sentence and source identity.
- **Inspect provenance.** Open Tree, expand a summary to an original, then inspect a note's source links. A paraphrase alone does not prove original retention.
- **Import/export.** In an isolated account, import the documented JSONL shape, repeat the same file, and confirm no duplicate entries. Download an export and inspect its records.
- **Checks.** Run `pnpm test tests/memory.test.ts tests/memory-application.test.ts tests/memory-summary-retry.test.ts`.
- **Restore.** Use `pnpm exec tsx scripts/restore-memory.ts pi-memory.jsonl recovered.sqlite` only with a downloaded private export and a nonexistent destination.
- **Proof.** Record the original match and export/restore result, without committing private archive content.

## Gotchas

- Memory backup excludes model credentials, auth state, and private reasoning. It is not full-account disaster recovery.
- Restore tooling creates a new local database. Replacing a production Durable Object is a separate operator migration.
- The UI inspects notes; it has no direct note editor. Scheduled automatic memory dreaming is not implemented.
- Summary availability and actual cache-use measurements are distinct from original-message retention.
