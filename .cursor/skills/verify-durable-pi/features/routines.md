# Scheduled routines and incoming events

Run an agent on a one-off schedule, elapsed interval, or authenticated event, then inspect its result in the same conversation.

## Sub-features

- `routines-schedule`: Create one-off, repeated, or event-only routines.
- `routines-control`: Run now, pause, stop the current run, archive, or restore paused.
- `routines-recover`: Preserve editing conflicts, unconfirmed changes, and model-unavailable waiting state.
- `routines-events`: Create, rotate, or disable a private webhook key.
- `routines-dedupe`: Reuse a stable event ID without admitting duplicate work.
- `routines-results`: Inspect recent runs and the owning conversation under existing permissions.

## How to get to it (user POV)

- Open `/agents/AGENT_SLUG/routines` or select Routines in the workbench.
- Ask the agent to create a routine; scheduling tools use their existing approval policy.
- Open a routine's Webhook settings. Copy its displayed POST endpoint and one-time key only into the authorized sender's private configuration.

## Driving it with the verification harness

Preconditions: Use a harmless one-off routine in an isolated agent. A live webhook test needs its private key; never include it in recorded commands.

- **Schedule.** Create `Feature map reminder` with instructions to return a unique test marker. Use **Run now**, leave the page, and confirm one saved result on return.
- **Pause/stop.** Pause future work separately from **Stop run**. Archive the disposable routine, then confirm restore returns it paused.
- **Event acceptance.** POST a small JSON object with `Authorization: Bearer` and `X-Event-Id` to the displayed endpoint. Repeat the identical ID/body; confirm one run. Use a changed body with the same ID only in a disposable test and expect conflict.
- **Checks.** Run `pnpm test tests/routines.test.ts tests/pi-routines.test.ts`; use the native runtime suite for restart behavior.
- **Proof.** Keep schedule/run identity, accepted event status, and the independent conversation result. Redact webhook keys.

## Gotchas

- Repeats follow elapsed time, not calendar/timezone recurrence. Missed intervals coalesce; only one routine waits/runs per agent.
- Runs have a ten-minute budget and normal model/tool permissions.
- Results appear in Pi. Automatic email/push outcome notifications are not implemented.
- Webhooks require a JSON object within 16 KB and stable event identity. Vendor-specific signature verification needs a trusted sender adapter.
- Rotating/disabling a key prevents waiting webhook work; stop an already admitted conversation separately.
