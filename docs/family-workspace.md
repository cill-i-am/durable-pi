# Family workspace

Pi has one invitation-only Better Auth organization. The deployment owner is its admin; new members must accept an invitation addressed to their verified email. The existing owner's user ID and agent namespaces survive the auth migration. Organization creation, role changes and admin removal are closed.

Membership shares access to Pi and the admin's ChatGPT model connection. It does not share agents, conversations, memory, files, approvals, profile photos or tool connections. Those retain their existing user and agent namespaces. Members see the family roster; pending invitations and membership changes are admin-only. Personal email and WhatsApp remain available only on the deployment owner's account until those channels support per-person routing.

## Screens and chat

Family and Model access live in Settings with durable URLs. Invitation links use URL fragments. Signup requires a current invitation; email verification and acceptance precede access to private agent APIs. Failed invitation delivery is recorded separately from invitation creation, so Resend retries pending invitations and renews expired ones.

Agents expose `read_family`, `manage_family`, `get_model_settings` and `set_model_settings`. Chat uses the same Better Auth organization operations and existing model-settings handler as the screens. The host derives the person from the actor's bound identity; model arguments cannot supply a user ID or role. The native tool approval policy applies to mutations.

Family chat actions use a server-only Better Auth hook context after reading live membership. This principal is never accepted for an HTTP request. The agent Worker has the auth D1 and auth-mail bindings plus the auth secret; none are provided to model tools, Terminal, execution Workers or user-created apps.

## Model and removal authority

Only the admin's root actor resolves and refreshes the ChatGPT credential. All other agents borrow access tokens through private RPC, with no refresh token. They read live membership before model requests and tools, and recheck after a remote refresh settles before releasing the borrowed token. Model defaults stay in each private agent's database.

Removing a member deletes membership and signals their actors to stop. Execution boundaries fail closed if membership cannot be read. Routines pause, unfinished turns receive stop intent, provider sessions are aborted, and background groups are cancelled. A persisted membership generation prevents old work restarting when someone is invited again. Private data is retained. Membership revocation cannot undo an external action that was already accepted by a provider.

## Verification and rollout

`tests/family-access.test.ts` exercises native Better Auth with production D1 queries over isolated SQLite. `tests/family-model-authority.test.ts` covers one refresh authority, no member refresh-token storage, removal during refresh, rejoining, and private chat model changes. Browser tests cover desktop/mobile invitation, verification, admin removal focus, read-only member settings and an editable draft during a shared model outage. The existing native workerd suites exercise the retained actor and transport boundaries.

Apply the additive auth migration before admitting family members. The migration bootstraps the sole account admitted by earlier releases; an empty installation bootstraps during owner setup. Real invitation delivery and the existing shared ChatGPT connection require production acceptance after deployment. Local checks do not establish either result.
