# Shared project checklists

Maintain a saved checklist with an agent through both chat cards and the workbench, with one revision history.

## Sub-features

- `checklists-create`: Create a titled project checklist from chat or the workbench.
- `checklists-edit`: Add/edit tasks, notes, optional due dates, and To do/In progress/Blocked/Done states.
- `checklists-shared`: Read the same live values in chat and Checklists.
- `checklists-conflicts`: Resolve stale edits without losing the draft; retry an unconfirmed save with its original identity.
- `checklists-history`: Inspect user/agent changes and the originating conversation.
- `checklists-archive`: Archive and restore without permanent deletion.

## How to get to it (user POV)

- Open `/agents/AGENT_SLUG/objects` or choose **Checklists** in the workbench.
- Choose **New checklist**, then fill **Project title**.
- Ask the agent to create or update a checklist. `list_objects`, `read_object`, `create_checklist`, and `update_checklist` use the same saved objects as the UI.
- Open the live chat card or the saved checklist to edit tasks and view History.

## Driving it with the verification harness

Preconditions: Use a new disposable checklist and a working model connection for chat creation.

- **Create.** Ask for a two-task `Feature map review` checklist or create it in the workbench. Open its **Live project checklist** card and full saved view.
- **Edit and reopen.** Complete one task through **Complete TASK_TITLE**, reload, and confirm the same status from the other surface. Ask the agent to read the current value.
- **Conflict.** Edit the same field from two views. Confirm the stale draft remains available and choosing saved values does not silently overwrite the newer edit.
- **Checks.** Run `pnpm test tests/working-objects.test.ts tests/working-objects-ui.test.ts tests/object-boundary.test.ts`.
- **Proof.** Capture the mutation, a fresh independent read, and the matching history entry. Archive the test object after verification.

## Gotchas

- Project checklist is the only implemented structured working-object type.
- Completing a checkbox records status; it does not prove or authorize an external action.
- Saving a UI edit does not start a model request. The agent can read current values on its next request.
- Objects are private to the owning agent/account. Limits include 100 tasks per object and 50 objects per agent, including archives.
