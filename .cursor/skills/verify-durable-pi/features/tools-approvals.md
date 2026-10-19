# Connections, tool permissions, and approvals

Connect trusted tool providers, select agent capabilities, and control exact actions through saved Allow/Ask/Deny policies.

## Sub-features

- `tools-connect`: Add supported HTTPS MCP endpoints and complete provider OAuth where required.
- `tools-executor`: Connect Executor once and expose its available entry points to existing/new agents.
- `tools-select`: Select other remote tools per agent and reload available tools.
- `tools-policy`: Set Allow, Ask, or Deny per tool; retain explicit overrides.
- `tools-decide`: Inspect full arguments, allow once, deny, or explicitly save Always allow for the matching tool policy.
- `tools-revoke`: Disconnect or cancel so future dispatch stops; retain interrupted outcomes for reconciliation.

## How to get to it (user POV)

- Open `/agents/AGENT_SLUG/settings/connections` through **Models & connections → Connections**.
- Choose **Connect Executor** or add a trusted public HTTPS MCP endpoint; sign in if requested.
- Open `/agents/AGENT_SLUG/settings/access` through **Agents & tools** for tool selection/policies.
- Use the inline approval card in chat, a linked Activity action, or the signed email decision card. Executor decisions use its own approval page.

## Driving it with the verification harness

Preconditions: Do not add a real provider or authorize an external action just to populate a map. Use an existing authorized connection or a synthetic boundary.

- **Policy UI.** Run `pnpm test:browser tests/browser/access.spec.ts`. Refresh before a conversation and verify a saved per-tool override.
- **Pi approval.** On a harmless test tool already set to Ask, inspect its full input and choose **Deny**. Reload and verify the operation stayed denied without execution. Choose **Allow once** only for an authorized test action.
- **Provider state.** Inspect an existing connection's available tools. For Executor, distinguish Pi's Allow policy from Executor's own paused approval and resume flow.
- **Remembered permission.** Inspect **Always allow** without selecting it during a read-only audit. If an explicit policy-change test is authorized, save it for the matching tool and independently reopen its Allow setting. Email approval remains one operation only.
- **Checks.** Run `pnpm test tests/access.test.ts tests/access-remember.test.ts tests/access-coordination.test.ts tests/mcp-oauth.test.ts`.
- **Proof.** Keep the exact action, decision, saved tool receipt, and provider outcome separately. Never export credentials or OAuth links.

## Gotchas

- Executor defaults become available after workspace authorization. Other remote tools require explicit selection.
- Supported endpoints use Streamable HTTP with anonymous access or compatible public OAuth registration. Arbitrary auth headers and credential-bearing URLs are unsupported.
- Skills, memory, incoming email, and presentation cards cannot grant permissions.
- A provider-accepted action can finish after disconnect or cancellation. Reconcile an uncertain action at that provider before replaying it.
