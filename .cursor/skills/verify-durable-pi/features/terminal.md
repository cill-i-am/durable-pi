# Linux commands, interactive shell, and file transfer

Run Linux work in an isolated workspace, retain saved files, and transfer selected files to and from the agent library.

## Sub-features

- `terminal-command`: Run shell, Node, and Python commands with streaming output and saved receipts.
- `terminal-checkpoint`: Save/restore the retained workspace between command containers.
- `terminal-interactive`: Open a leased shell, resize, interrupt, reconnect, and explicitly save or discard.
- `terminal-network`: Choose the agent's outbound-internet policy before new work.
- `terminal-import`: Copy selected private files into a fresh workspace import directory.
- `terminal-export`: Prepare an exact-byte saved-workspace export and optionally add it to Files.

## How to get to it (user POV)

- Open `/agents/AGENT_SLUG/terminal`; choose Commands, Interactive, or File transfer.
- Use **Shell command** for a command, or ask the agent to use `run_command`.
- Use **Copy from Files**, an absolute `/workspace/...` export path, and **Prepare export** for transfers.
- Interactive sessions offer **Save and close** and **Discard and stop**.

## Driving it with the verification harness

Preconditions: Real container checks require Docker locally or the configured Cloudflare Sandbox service. Use a disposable test file and no network request.

- **Persistence.** Run `printf feature-map > /workspace/feature-map.txt`, wait for saved workspace, then read it in a later command after container teardown.
- **Interactive.** Open a shell, inspect the same file, modify it, and choose **Save and close**. Confirm the change through a later command.
- **Transfer.** Copy a tiny library file in, prepare an export from the saved workspace, download it, and compare bytes. Add it to Files only when testing that path.
- **Checks.** Run `pnpm test tests/terminal.test.ts tests/terminal-transfers.test.ts tests/terminal-lease.test.ts tests/terminal-authority-sync.test.ts`.
- **Proof.** Keep command/output, checkpoint state, fresh restore result, and transfer byte comparison. Remove only the test file and explicitly save that cleanup.

## Gotchas

- Files persist through checkpoints; processes and shell environment do not.
- Internet is disabled by default. Policy changes require an idle, cleaned-up terminal; admitted commands retain their original policy.
- Interactive sessions are leased and limited to ten minutes. Lost authorization/lease stops them without saving.
- Exports read the saved checkpoint, not unsaved interactive changes. Exports must be regular, nonempty files within the supported size limit.
- A failed/uncertain checkpoint preserves the prior saved workspace; cleanup failure can block later commands.
