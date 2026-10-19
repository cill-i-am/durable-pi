# Private generated apps

Let an agent publish a bounded private interface with saved state, then interact with it through chat or Apps.

## Sub-features

- `apps-definition`: Create immutable drafts for tables, forms, checklists, metrics, and text.
- `apps-publish`: Preview, publish, republish an earlier definition, archive, and restore.
- `apps-interact`: Save supported button/form interactions and queue a corresponding agent event.
- `apps-web`: Run custom server-side JavaScript in an isolated Cloudflare environment and show bounded HTML/CSS.
- `apps-recovery`: Preserve state conflicts, unconfirmed changes, and replay-safe interactions.

## How to get to it (user POV)

- Open `/agents/AGENT_SLUG/apps` or a published app card in chat.
- Ask the agent to build and publish a small private app. Open the saved app, its version preview, or its stateful form.
- Use **All apps** to return to the collection and **Refresh app** to inspect saved state.

## Driving it with the verification harness

Preconditions: Use a disposable app with a local counter or text field, not an external action. Real code execution requires the deployed service.

- **Create through chat.** Ask for a private counter app that increments by one and performs no network calls. Inspect publication before opening the app.
- **Interact and reopen.** Increment once, leave, and reopen from Apps. Confirm the saved count and one corresponding event in the agent conversation.
- **Version boundary.** Preview an older definition without publishing, then explicitly publish if testing. Distinguish the definition version from form-answer history.
- **Checks.** Run `pnpm test tests/apps.test.ts tests/web-apps.test.ts tests/app-pump.test.ts tests/pi-apps.test.tsx`.
- **Proof.** Record published version, the interaction, fresh saved state, and the correlated event. Archive the test app.

## Gotchas

- Apps are private, not public shared websites.
- Generated JavaScript runs server-side. Arbitrary client scripts/frameworks, CDN dependencies, and network access are not supported.
- Republish restores a definition, not historical user answers.
- Apps and shared checklists have different saved records. Interactive apps have no equivalent email/WhatsApp UI.
