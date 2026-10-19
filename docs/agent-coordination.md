# Agent coordination and message authorship

Each bot is the privacy boundary for this first version. A session is an original conversation turn and its native Pi conversation. The shared chat, the session, and each participating agent have separate identities. Main agents can discover and contact other main sessions in the same bot. Children can discover, message, and read the latest answer of their parent and peers in their own session.

| Tool | Behavior |
| --- | --- |
| `spawn_agents` | Starts up to three children and returns immediately. Selected read tools only; no nested delegation or outside actions. |
| `list_agents` | Returns the current session's main agent, children, addresses and status, including the caller's address. |
| `list_sessions` | Main agents only: paginated discovery within this bot. |
| `send_message` | Records an addressed message and returns its receipt. `replyTo` must identify a message between those participants. |
| `get_last_message` | Returns an agent's latest completed answer and latest delivered message to the caller. |

`delegate_tasks` retains its synchronous combined-report behavior. For interactive collaboration, use `spawn_agents`. Idle children remain available until the ten-minute group deadline. Activity exposes steering and Stop for them. There are at most three open asynchronous groups, twelve model requests per child, sixty-four coordination messages touching each session, and twelve model requests per resumed main turn. New work must use a new session after those limits. A full 10,000-message bot archive rejects additional messages; automatic retention is not implemented.

The directory is a projection of conversation turns and native delegation records. SQLite stores message receipts, retry scheduling, closed-session fences, and continuation budgets. Each native delivery uses the durable message ID as its submission key. Delivery is retried in recipient order; an uncertain acknowledgment cannot admit the same native input twice. Admission to a main conversation and its delivery receipt share one SQLite transaction. Lifecycle recovers pending work after a restart. A busy recipient is steered; an idle main agent resumes its existing native conversation. Resumed main agents receive only the four coordination tools. Other tools still require an original human task and the existing access policies.

Only addressed agents receive peer messages. Parent human steering remains available to all of that parent's children. Completed asynchronous child answers are reported back to the parent without waiting on a tool call. Explicit peer messages do not imply a new human request, approval, or permission.

## Authorship and multiplayer preparation

Authorship is application metadata, independent of the provider's `user` or `assistant` role. Public send/control schemas discard caller-supplied identity. Authenticated HTTP ingress and verified email/WhatsApp admission supply a stable human ID. Native tool execution supplies an agent ID and session ID. Routines, app events, background reports and tool results use service or agent authorship as appropriate. Messages retain recipient, reply and causation references. Relaying a person's words never changes the relay's author into that person.

Conversation rows, archive export/restore, retrieval and summary inputs retain the metadata. Summary instructions require retaining who requested, suggested or approved something; summaries themselves are never authorization records. Historical records without provenance remain unknown. Adding real multiplayer requires authenticated conversation membership and per-actor permissions at all entrypoints and retrieval boundaries. This change does not make bot boundaries shared or implement multiplayer membership, invitations or UI.

Shared task status retains open asynchronous sessions under their original request handle after the parent's initial reply. Stop closes that session and fences queued messages. A family membership change also closes its old session groups, so a later invitation cannot revive previously authorized work.

## Verification

`pnpm test` covers message scope, forged identity, replay, recipient ordering, expiry, cancellation, archive restoration and native Pi restart behavior. `pnpm test:communication-runtime` runs the production PersonalAgent in workerd with synthetic models, including nonblocking spawn, child discovery/question, parent reply, automatic findings and continuation in the original native session. These deterministic checks establish execution behavior, not model judgment.

With `OPENAI_API_KEY` and `EVAL_MODEL` supplied to the process, run `pnpm eval:coordination` for live model tool-selection and authorship cases. It uses the actual tool declarations and synthetic conversations. It never executes the selected tools. Missing credentials exit with status 2 and are not a pass. Inspect the reported calls and prose; a single successful run does not establish reliability across models, prompts or conversation lengths.
