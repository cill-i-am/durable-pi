# Family membership and shared model access

Invite family members to their own private workspaces while sharing the admin's ChatGPT connection.

## Sub-features

- `family-invite`: Invite a specific email, inspect delivery state, resend, or cancel an invitation.
- `family-join`: Create an invited account, verify email, accept membership, and enter a private workspace.
- `family-roster`: Let members read the roster; reserve membership changes for the admin.
- `family-remove`: Remove membership, stop further admitted work, and retain private data.
- `family-model`: Inspect shared model availability and reconnect ChatGPT as the admin.
- `family-chat`: Read family state and request supported membership/model-setting actions through an agent.

## How to get to it (user POV)

- Open `/family` or **Settings → Family**.
- Open `/family/model-access` for the shared ChatGPT connection.
- Open the private invitation link at `/join` to accept. Keep its URL fragment private.
- In chat, ask who belongs to the family or ask for an invitation; the agent can use `read_family` and `manage_family`.

## Driving it with the verification harness

Preconditions: Distinguish an admin from a member. A real join requires an invitation addressed to a verified email.

- **Admin controls.** Run `pnpm test:browser tests/browser/family.spec.ts --project=desktop --grep 'admin can invite'`. **Invite someone** records the address; **Remove from family** defaults focus to Cancel and explains retained data.
- **Member and outage states.** Run the same spec with `--grep 'member family screen'`. Membership controls are absent and an unavailable shared model leaves the draft editable.
- **Invitation recovery.** Run `pnpm test:browser tests/browser/invitation-recovery.spec.ts --project=desktop`. Temporary preview failure can recover without replaying verification; cancellation remains unavailable.
- **Authority checks.** Run `pnpm test tests/family-access.test.ts tests/family-model-authority.test.ts`. These test native auth and credential boundaries, not delivery to a real inbox.
- **Proof.** On a live acceptance run, verify invitation receipt and the member's distinct agent list. Record removal and a denied subsequent access attempt.

## Gotchas

- Membership shares application/model access, not agents, files, memory, approvals, tool connections, or profile photos.
- Personal email and WhatsApp are deployment-owner channels. Per-person channel routing is not implemented.
- There is one invitation-only family organization. Arbitrary organization creation and role administration are outside this feature.
- Removal cannot reverse an external action already accepted by its provider.
