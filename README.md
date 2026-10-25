# Durable Pi

A private, durable agent workspace built with **Pi Durable**, Cloudflare Durable Objects, **TanStack Start and AI**, **shadcn/ui on Base UI**, Better Auth, and **Alchemy Effect**.

Production: [bot.cill-i-am.com](https://bot.cill-i-am.com). Alchemy attaches this hostname to the existing website Worker and manages its DNS and TLS certificate. The production zone is pinned in `alchemy.run.ts`; development keeps its local URL. `Worker.URL` supplies the canonical origin to authentication. The previous `workers.dev` address redirects page requests to this address; mutations require the canonical origin. Sign in again on the new hostname using the existing account.

Pi owns model turns, tool execution, committed transcripts, and recovery. The application adds invitation-only account access, a durable submission queue, a lossless message archive, a binary summary tree, and sourced Markdown memory notes. ChatGPT subscription access uses Pi's current OpenAI sign-in flow.

TanStack AI's React client owns the browser's conversation messages and processes the authenticated SSE stream. A Pi adapter translates committed turns, reasoning, steering and tool results into TanStack message parts. Reconnecting reads a fresh snapshot; it does not repeat a model request or tool. Pi still owns durable send/steer admission, cancellation, approvals and recovery. The shadcn/Base UI components render that client state.

Browse the current product and surface coverage in the [feature map](FEATURES.md). Use the [verification skill](.cursor/skills/verify-durable-pi/SKILL.md) for user-journey checks and the [architecture guide](docs/architecture.md) for domain ownership. Implementation history and acceptance records remain in [BUILD.md](BUILD.md).

## Email an agent

After deployment and email activation, new agents have email enabled by default. Open **Settings → General → Email this agent**, copy its private address and email it from your enrolled owner inbox. The request and attachments enter the same conversation and file pipeline as the web app. Answers and selected reply files return to that inbox. Explicitly disabled agents stay disabled until re-enabled. Emails wait in durable storage while the model is disconnected.

Action approvals arrive as readable cards. **Approve once** and **Deny** open a prepared email; send it to confirm. You can also reply with the exact first-line command from the card. Decisions are signed, scoped to one operation and revision, and expire with the action. Opening an email or button never approves it. Executor continues to handle its own approvals.

Agent links use persisted name slugs, such as `/agents/personal-assistant`. Old ID URLs still work and become canonical slug URLs. Slugs stay stable after renaming so bookmarks and email links remain usable.

Keep the address private: it contains a routing capability. **Disable email** revokes incoming access and cancels unsent replies. Re-enabling creates a new address. An already started provider send can still finish. Disabling email does not stop an admitted conversation; use the conversation's Stop control for that.

**Recent email** shows reply delivery state. A provider acceptance is shown as **Sent**, not proof of inbox placement. A crash or uncertain provider response produces **Delivery unconfirmed** without automatic resend. Check your inbox before selecting **Retry reply → Send again**. Retrying a lost settings or retry acknowledgement uses **Retry same request** with the saved operation ID.

Email accepts plain text, HTML-only messages and supported workspace attachments. Limits are four files, 8 MiB each, within 20 MiB raw MIME; 25,000 body characters; 20 pending requests; 2,000 retained receipts; and 100 explicit retries per reply. Automated mail and mailing lists are rejected. Settings list the latest 30 receipts, including approval notifications. Outgoing selected files are batched within a 16 MiB attachment budget per email, keeping the full answer and every selected file in the thread. Shared [reply delivery](docs/decisions/reply-delivery.md) checkpoints each provider message; WhatsApp splits full text and sends original files separately. Explicit retries skip confirmed parts. Replies and approval notices go only to the enrolled `OWNER_EMAIL`. General outbound mail to other people and unrelated proactive notifications remain separate capabilities. See [the email parity decisions](docs/decisions/email-surface-parity.md).

### Activate email delivery

1. Configure a mail subdomain, such as `agents.example.com`, in [Cloudflare Email Service](https://developers.cloudflare.com/email-service/configuration/subdomains/). Configure routing and sending for that subdomain, including its provided MX, SPF, and DKIM records. Keep the existing apex-domain mail configuration. Verify the owner destination address or enable Email Sending for the subdomain.
2. Set `AGENT_EMAIL_DOMAIN` to that subdomain and `EMAIL_ADDRESS_SECRET` to an independently generated secret of at least 32 characters. Use `.env` for local configuration. For CI, use the production GitHub environment variable `AGENT_EMAIL_DOMAIN` and secret `EMAIL_ADDRESS_SECRET`. The optional environment variable `EMAIL_REVIEW_URL` defaults to the production app origin. Keep secrets out of source, logs, and screenshots.
3. Deploy through the existing Alchemy workflow. The stack includes `EmailWorker`, with public HTTP disabled and invocation logging off. Enable Cloudflare subaddressing and create one literal routing rule for `pi@<mail-subdomain>` with this Worker as its action. Private addresses use `pi+<agent>.<token>@<mail-subdomain>`. Cloudflare matches the base alias and passes the complete recipient to the Worker; verify that the private suffix is preserved. Subdomain catch-all rules are not supported.
4. Open an agent’s enabled email settings. Send a real email from the enrolled inbox, receive a reply, and reply again. Verify the conversation in Pi and the `In-Reply-To`/`References` headers in the inbox. Repeat the same inbound message and confirm that it creates one task.

The application starts with email unavailable when the domain or secret is missing, and new/unconfigured agents inherit enabled email once configuration is available. Explicit disable choices are preserved. Creating the Worker does not establish domain readiness or verify inbox delivery. Local tests use synthetic mail, models, and provider responses; `pnpm test:communication-runtime` also kills a native worker during a send and checks recovery without resend.

## Persistent working objects

A working object is structured information you and your bot maintain together beyond a conversation. The first type is a **project checklist**, with tasks, To do / In progress / Blocked / Done statuses, optional due dates, and supporting notes. Ask the bot to create one, or open **Workbench → More workbench tools (⋯) → Checklists → New checklist**. A bot-created checklist appears as a live editable chat card and in the full workbench. Both surfaces read the same saved object. History identifies your edits and the agent's edits; the originating conversation remains available from the object.

Checklists are private to their owning bot and authenticated owner. Saving a task does not start a model run. On its next request the bot receives current object references and change indicators, and can read live state using `read_object`. Chat, tool snapshots and OptChat memory may reference the object; the native Pi document is authoritative. Tools `list_objects`, `create_checklist` and `update_checklist` use the same Effect operations as UI edits. Checklist completion is a status, not evidence that an external action happened or permission to perform one.

Edits target fields at a specific revision. A conflict preserves the submitted draft, shows the latest values, and requires an explicit choice before reapplying it. Unconfirmed saves retain their operation ID in browser session storage; **Retry same save** cannot duplicate the mutation, and **Cancel pending save** confirms whether it already applied. Archive and restore preserve tasks and history; there is no permanent-delete action. Objects currently allow 100 tasks each, 50 objects per bot including archives, and 20,000 mutation receipts per bot. Limits fail explicitly without discarding existing objects.

Pi Durable session-scoped document families persist the catalog, checklist state, immutable change events and operation receipts in atomic commits inside the bot's Durable Object. No separate editable R2 or chat copy is created. Restart recovery replays document tools only under the original unexpired, unchanged access grant. Existing approval and interruption rules remain in force for external actions. Other object types are future product slices.

## Run it

Requires Node 24+ and pnpm 12.14.0. Install with `pnpm install --frozen-lockfile`. Type checks use TypeScript 7's native Go compiler. The `typescript` package name points to Microsoft's TypeScript 6 compatibility package for tools that still need its compiler API; `@typescript/native` supplies the TypeScript 7 `tsc` command.

1. Copy `.env.example` to `.env`. Set `OWNER_EMAIL`, and generate separate random values of at least 32 bytes for `BETTER_AUTH_SECRET` and `SETUP_TOKEN`. Keep `.env` private.
2. Run `pnpm model:login`. Complete the official ChatGPT login in your browser. The script writes the credential to `.env` with mode `0600`; it never prints tokens.
3. Run `pnpm dev` with an authenticated Alchemy `default` profile, or `pnpm exec alchemy dev --stage dev --profile durable-pi` to use the configured project profile. Alchemy emulates Workers, Durable Objects, D1 and R2 locally; Browser uses the real Cloudflare Browser Run service because local Chromium does not enforce its network guardrails. Browser use incurs the account’s normal usage. The app URL appears in the output.
4. Open the app, choose **First time? Set up your account**, and enter your private setup key and a password. Only the configured owner's email can be registered. Registration closes once that account exists.

To reconnect a saved Pi registration, run `pnpm model:reauthorize --credential-file .env --expected-email owner@example.com`, using your ChatGPT account email. Keep the original `.agent-device-id.local` host file; `--device-file` selects it when using a separate checkout, and `--env-file` selects the private output. Returning sign-in reuses the issued client ID, verifies the callback and signed account identity, then atomically saves the new credential. Deploy the credential through the production secret workflow only after local sign-in succeeds.

`pnpm verify` runs static checks, unit tests, native runtime recovery checks, the website and Worker builds, desktop and mobile browser journeys, and the terminal container's media checks. Start Docker and install Chromium with `pnpm exec playwright install --with-deps chromium` before the first full run. These checks do not need provider credentials.

Run `pnpm verify:browser` to check sign-in, opening an agent, sending a message, receiving a reply, and reloading the conversation. It uses the real workspace UI with synthetic authentication and reply transports; it does not verify production sign-in or call a model. Failure screenshots and traces are saved in `test-results/`. `pnpm verify:container` builds the production `linux/amd64` terminal image and runs its video checks through the Dockerfile.

CI runs the verification suites in parallel and requires the aggregate `check` result before merging. Container builds use GitHub's layer cache and run when a PR changes the container or workflow, and on every push to `main`. Renovate's root configuration discovers package manifests and pnpm workspaces across the repository. It groups related updates, pins GitHub Actions to commit revisions, and keeps automatic merging disabled. The hosted Renovate app must have access to this repository; updates to patched dependencies can require regenerating their patches.

`pnpm run deploy` provisions the production stage through Alchemy using the explicitly configured profile. A Cloudflare account with Workers, D1, and R2 permissions is required; hosting charges are separate from ChatGPT model usage.

`pnpm typecheck` retains TypeScript 7 as the required compiler. `pnpm typecheck:rust` exposes the experimental tsrs checker; it currently reports a recursive Zod type incompatibility on this project. `pnpm lint:effect` runs standalone Rust Effect diagnostics. Errors fail static verification; warnings and suggestions stay advisory. Existing Oxlint correctness rules remain enforced. Keep optional dependencies enabled for the native binaries. See [tooling measurements and compatibility](docs/typecheck-tooling.md) for benchmarks, commands, and fallback details.

Production uses the dedicated `durable-pi` Alchemy profile. Configure it with `pnpm exec alchemy profile create durable-pi` and `pnpm exec alchemy profile edit --profile durable-pi`, selecting Workers scripts read/write, D1 read/write, Workers R2 Storage read/write, account settings read, memberships read, and user details read. OAuth adds offline refresh access. A fresh machine also needs Secrets Store read/write to retrieve remote-state credentials; an existing trusted state-credential cache avoids that additional local permission.

Workers use the `2026-09-25` compatibility date. Alchemy beta.83 bundles local workerd `2026-10-02`. Local development keeps infrastructure state under ignored `.alchemy/state`; deployments share the encrypted Cloudflare state service. Use a separate ChatGPT login for independently running deployments: OAuth refresh tokens rotate.

## Account security

In **Settings → General → Your profile photo**, choose a JPEG, PNG or WebP up to 10 MB. The browser crops the centre to a 512-pixel square and re-encodes it to strip metadata. Your photo appears in the personal workspace menus immediately and persists across sign-ins. Choose **Remove photo** to return to initials.

Better Auth owns the existing user image field. Photos live in the private `UserAvatars` R2 bucket, bound only to the website as `USER_AVATARS`; `/api/account/avatar` checks the owner session for every read and write. Uploads are limited to 1 MB after resizing, and mutations require the app’s origin. Alchemy provisions the bucket with the next deployment; no database migration is needed.

Open **Personal → Account security → Set up two-factor**. Confirm your current password, scan the QR code with your authenticator, and enter its six-digit code. Protection turns on only after verification. Save the recovery codes somewhere private; each code works once if you lose access to your authenticator.

The same panel lists your browser sessions and marks **This browser**. Sign out a specific session or all other browsers. Device names are inferred from the browser, so entries represent sessions rather than guaranteed physical machines. Revoked browsers lose access to new requests immediately; open connections close within one minute. Your agents and saved work keep running.

**Manage** lets you replace recovery codes or turn off two-factor protection after confirming your password. Replacing codes invalidates the old set. Enabling or disabling protection signs out other browsers. Resetting your password also signs out existing sessions, but keeps two-factor protection enabled.

## Automatic deployments

Following [Alchemy's CI guidance](https://alchemy.run/environments/ci/), `.github/workflows/check.yml` deploys production after verification passes on a push to `main`. Pull requests run checks without deployment credentials. The GitHub `production` environment is restricted to `main`; production deploys are serialized and never canceled halfway through. A post-deploy check verifies the homepage and anonymous access restrictions.

`stacks/github.ts` is a separate, manually deployed setup stack. It creates an account-scoped Cloudflare deploy token and writes the application configuration to encrypted GitHub environment secrets. The token has Workers Scripts read/write, D1 read/write, Workers R2 Storage read/write, Account Settings read, and Secrets Store read/write permissions. Cloudflare requires [Secrets Store Edit](https://developers.cloudflare.com/secrets-store/access-control/) to bind the existing state credential to Alchemy's temporary preview Worker; Read only exposes metadata. The token cannot create further API tokens. Only the setup stack uses an administrator profile:

```sh
CLOUDFLARE_ACCOUNT_ID=your-account-id pnpm exec alchemy deploy \
  --config stacks/github.ts --stage production --profile your-admin-profile
```

CI resolves credentials from environment secrets, not the local OAuth profile. Its token can access the existing Alchemy state service. Keep the Alchemy version pinned and review state-service changes before upgrades, because that service is shared across projects. Keep the setup stack's state private, and rerun setup to rotate configuration or permissions.

For the initial local-to-remote state migration, `scripts/migrate-production-state.ts` copies only this app's production records, rejects conflicting remote records, verifies each write, and retains the local backup. Run it without `--apply` first. Never switch an existing deployment to an empty state store.

## What is implemented

- A private bot catalog: create, rename, select, archive and restore bots. The original chat remains the personal assistant; each new bot has its own conversation, memory, notes and backups.
- Queued messages, committed response updates, stop, retry-safe submission IDs, and reopening after a restart.
- One fresh Pi conversation per user turn. Prior context combines saved summaries and recent original messages within a byte budget, with `zoom`, `search_memory` and `date` to retrieve full originals. Summaries and backups run in the background and do not gate replies.
- The reference compaction prompt, a 512-byte scale example, five byte-feedback attempts, eight concurrent compactions with a source-order barrier, and durable ten-second retries. Aligned binary merges preserve an incremental view that never splits.
- Exact archive search, private Markdown notes with source message IDs and revision history, and a memory inspector.
- Better Auth sessions and authenticator two-factor protection backed by D1, with encrypted recovery codes and individual/bulk browser-session revocation. An authenticated server route forwards to a Worker with both public and preview URLs disabled. Bot objects are addressed from the authenticated owner ID and a validated catalog identity. The default bot retains its original object ID.
- Server-side ChatGPT credentials with one account-level refresh owner and durable token rotation shared by all bots. Model requests require the ChatGPT subscription credential; API-key fallback is disabled.

The current slices include live reply updates, mid-run steering, image and video-frame attachments, private files, searchable PDF text, reusable skills, tool approvals, per-bot MCP tools, a Cloudflare browser with owner takeover, JavaScript and Linux execution, versioned private apps, scheduled/webhook routines, shared project checklists, native working-context compaction, and automatic durable task plans in Activity. Foreground/background delegation is also available; remaining activity/recovery work are tracked in [BUILD.md](BUILD.md).

## Memory design

[Victor Taelin's OptChat specification](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449) defines the memory behavior:

- Every committed user message, reply, tool call, and tool result is archived verbatim. Reasoning stays in Pi's private transcript and is excluded from the searchable memory archive. Previous releases capped very large tool-result projections; those historical projections are retained as written.
- Summary nodes target 512 UTF-8 bytes. Short sources are copied without a model request; longer ones use a 512-dash ruler and up to five attempts in the same conversation. The shortest result is retained even if still oversized, as the specification requires.
- A lifecycle job owns up to eight scoped Effect fibers, refilling slots on completion from a persisted ready queue. Original messages remain sequential; ready merges run alongside them. Each provider failure persists a ten-second retry deadline and reports its first failure without logging provider content. Timeouts and cancellation abort Pi requests; storage failures and defects fail the job and interrupt siblings.
- The view grows by appending lines until it exceeds 128,000 summary bytes, then merges aligned, built siblings down to 64,000 bytes. Priority is `(total - (start + 2 * count - 1)) / count`, measuring age from the pair’s last message. This corrects the original spec’s cache-destroying first-message priority and continuous merging. The view and unfinished batch state survive restarts; old ranges never split. The compactor has its own persisted 16–32 KB view, reset when the main view merges. A turn captures the view before appending its new user message, atomically with its saved prompt.
- Each turn has a fresh Pi conversation. Turns and OptChat memory summaries share the same constant system prompt and tool definitions; memory summaries are instructed never to call tools. The memory view is a separate content block with explicit cache breakpoints before the 50,000, 80,000, and 100,000-character line boundaries. Requests use a stable owner-specific cache key, `store: false`, and `reasoning.context: all_turns`; Pi retains encrypted reasoning and tool replay. No long-retention or cache-renewal requests are made. The Files tab reports actual cached/input usage; short histories may have no cache hits.
- Within an active run, Pi’s native compactor summarizes older working context while preserving recent tool pairs and steering. Its model-aware policy uses the pinned run model: the current 272k window compacts above 112k, reserving 160k and keeping roughly 20k recent tokens. Native summaries use Pi’s own prompt and uncached requests. They never become original user messages in OptChat; original messages and tool results remain retrievable. Display caches retain a bounded recent view. OpenAI server-side compaction is not enabled. Threshold rationale, restart verification and limitations are recorded in [BUILD.md](BUILD.md).
- Substantial requests use `update_plan` during ordinary execution. Plans keep objectives, constraints, completion criteria, steps, blockers and evidence in native Pi documents. Activity shows progress and revision history without requiring plan management or approval. Fresh plan context survives compaction and restart; cancellation never restarts saved work. Evidence labels distinguish validated records from agent-reported completion. Simple chat can proceed without a plan.
- The memory inspector opens summaries down to original messages. Authenticated exports stream a linked, script-free HTML archive or JSONL with the log, tree, view, and note revisions.

The memory bounded context lives in `src/memory`: domain values and merge policy, an Effect repository port, compaction, and archive/import/backup workflows. SQLite, Pi and R2 adapters live under `src/memory/adapters`. `src/agent` owns conversation sessions, turn state, tool registration and Lifecycle alarms. The Durable Object composes one managed Effect runtime; only host callbacks and synchronous transaction boundaries execute it. The SQLite adapter keeps transactions synchronous and exposes no driver handle through the memory port. Oxlint enforces the dependency direction.

The Agents context owns the owner catalog. Its SQLite adapter and versioned child admission policy live under `src/agents/adapters`. Archive acknowledgement waits for the child to reject new messages; work admitted before archival may finish. Frontend capabilities live under `src/features`, composed by `src/app/workspace.tsx`.

During a reply, choose steering at the next tool boundary or queue a fresh turn. Stop preserves the message and cancels waiting tool approvals; a tool already dispatched may finish. Optional OptChat subagents are not connected yet.

### R2 backup and recovery

The private `MemoryBackups` bucket holds incremental, SHA-256-addressed batches of messages, summary nodes, and note revisions. A completed manifest contains the view and high-water marks. Uploads checkpoint progress in bounded batches and only publish `latest.json` after every referenced record is stored. Failed uploads retry; prior complete snapshots remain recoverable. The app checks for unfinished work after restart and exposes the last complete backup time in **Memory → Files**. Runtime credentials, auth records, and private reasoning are excluded. This is a memory backup, not a full application or account backup.

R2 has no public URL or custom domain. The agent accesses it through its bucket binding. Provisioning requires the CI token's account-level Workers R2 Storage read/write permissions. Application exports require the owner session.

To restore a downloaded JSONL archive into a **new local SQLite database**, run:

```sh
pnpm exec tsx scripts/restore-memory.ts pi-memory.jsonl recovered.sqlite
```

For R2, download the relevant `memory/<object-id>/` prefix through an authenticated Cloudflare client, preserving object paths, then run:

```sh
pnpm exec tsx scripts/restore-memory.ts downloaded-bucket recovered.sqlite memory/<object-id>
```

The restore command checks batch hashes, missing records, source references, tree ranges, and the saved view. It refuses to overwrite an existing file and creates the output with owner-only permissions. It does not modify production. Keep archive files private. Recovering into a replacement Durable Object is a separate operator-controlled migration; do not delete or replace the existing namespace to restore data.

### Import older history

**Memory → Files → Import history** accepts JSONL with one `{ "kind": "note", "text": "An older memory", "date": "2020-01-02T10:00:00Z" }` object per line. Supported kinds are `user`, `talk`, `tool`, `echo`, and `note`. Each upload allows 200 messages, 30,000 characters per message, and 1 MB total. Split larger histories into smaller files. Validation is atomic, original dates are retained, and retrying the same canonical file does not duplicate messages. Imports enter the archive without submitting their contents as an active instruction.

[Cognition's Agent Memory Repo](https://cognition.com/agent-memory-repo) informs the linked, sourced Markdown notes. Here those notes and their revisions stay in private SQLite. They are never pushed to the public source repository. Automatic scheduled “dreaming” is not enabled.

[Sawyer Hood's Pi Durable demo](https://x.com/sawyerhood/status/2107872386339287239) informed the standalone hosted-chat direction. [Whirl](https://github.com/whirlchat/whirl) informed the compact composer interaction; its Convex-dependent composer is not embedded. The UI uses native shadcn Base UI source components.

## External tools

Open **Agent settings and tools (⋯) → Connections** in a bot, add a trusted public HTTPS MCP endpoint, then choose **Sign in** if the provider requires OAuth. Use **Reload** after authorization. This supports Streamable HTTP servers with anonymous access or public OAuth registration; bearer-token URLs and custom headers are not accepted. Connection credentials stay in the owner's private Durable Object.

Choose **Connect Executor** to configure `https://mcp.executor.sh/mcp?elicitation_mode=browser`. After workspace authorization, all existing and new agents automatically receive Executor's six entry points: skills, search, describe, call, execute, and resume. Executor keeps connected service credentials and handles action approvals on its signed-in browser page. Agents show an approval URL and collect that decision with resume; they must not rerun a paused program. Executor defaults to Allow in Pi, with per-agent Ask/Deny overrides available in **Agents & tools**.

Select other connected tools for each bot. New selections require approval of the exact inputs; **Agent settings and tools (⋯) → Tool access** changes Allow/Ask/Deny per tool. Disconnect blocks new calls for every bot. Reconnecting invalidates old explicit selections, which must be removed and selected again; Executor defaults refresh when a job starts or tool settings open. Removing and re-adding an explicitly selected tool restores Ask. Actions already sent to a remote service can still finish; an interrupted result must be checked there before retrying.

The integration follows the [Cloudflare MCP client API](https://developers.cloudflare.com/agents/model-context-protocol/apis/client-api/). The pinned SDK has a small pnpm patch for concurrent refresh-token rotation, verified by `tests/mcp-oauth.test.ts`; retain its regression tests when upgrading or removing the patch. Workspace authorization is required before Executor becomes available. [Decisions and release evidence](docs/decisions/executor-defaults.md) distinguish implementation, authorization, and live verification.

## WhatsApp an agent

WhatsApp uses the official [Chat SDK adapter](https://chat-sdk.dev/adapters/official/whatsapp), with native Cloudflare Durable Object state. It shares the existing Pi conversations, models, memory, Executor connection and approval controls. One configured owner can message one business number and switch agents with `/agents` and `/agent <id>`. Settings → General → WhatsApp also selects the agent and enables or disables the channel. Each admitted request keeps its original agent after a route change.

The connection starts unavailable until Meta credentials and the owner identifier are configured. Live Meta onboarding and message acceptance are deferred. To activate it later:

1. Set up a Meta WhatsApp Business application and number. Store `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` and `WHATSAPP_OWNER_ID` as production secrets. The owner ID must match the adapter's canonical sender identifier exactly, either a phone number without `+` or its business-scoped user ID. Unknown senders cannot run agents or receive private replies.
2. Set production variables `WHATSAPP_PHONE_NUMBER_ID` and, optionally, `WHATSAPP_BUSINESS_NUMBER` (international digits without `+`, for the contact link). Deploy with the existing production workflow.
3. Configure `https://whatsapp.cill-i-am.com/webhook` in Meta with the matching verification token. Subscribe to `messages` and `user_id_update` events. Signature validation uses the app secret.
4. Enable the channel in authenticated settings. Send a text message from the configured owner, inspect the conversation, and verify a reply, duplicate delivery, route switching and an approval wait before relying on it.

Incoming text, images and audio use WhatsApp's 24-hour customer-service window and the shared workspace pipeline. The reply adapter can export selected original files, including documents and video; incoming document/video messages are not yet accepted by the parser. Incoming PNG, JPEG and WebP photos use the same private workspace and server-side Cloudflare Images previews as web uploads. Captions remain part of the request. Image receipts persist before downloading, so redelivery and interrupted imports reuse the original file. The common `view_image` tool inspects saved photos, and `share_image` includes up to four workspace images in a reply across web and WhatsApp. WhatsApp sends supported originals up to 5 MB, or the bounded JPEG preview when conversion is needed, without publishing private URLs.

Voice notes receive text replies. The shared workspace pipeline retains the private original and creates a multilingual transcript using Cloudflare-hosted Whisper large v3 turbo. The agent's usual configured model then answers the request. Web supports recording, audio upload, playback and transcript disclosure. Finishing a recording attaches it for review before sending and closes microphone tracks. Originals use the existing 8 MB limit; transcription is bounded to ten minutes and 32,000 characters. Workers AI transcription is billed separately from the ChatGPT subscription. Speech generation is deferred.

Replies preserve complete text and selected original files through the shared multipart delivery pipeline. Messages wait durably when the model is disconnected. A closed reply window preserves the request for review in Pi. Real-time calls, speech output, proactive templates and approval by WhatsApp remain separate work; actions use the existing authenticated approval flow. Message origin never removes the agent's normal tools or saved permissions, including for agent-generated reports. Deliberately scoped delegated readers retain their explicit scope.

Recent message status records provider acceptance, rather than delivery or read confirmation. Interrupted or ambiguous sends become **Delivery unconfirmed** and never resend automatically. Check WhatsApp before an explicit retry; uncertain retries require acknowledgement of duplicate risk. Disabling stops new requests and replies that have not begun sending. Already admitted conversations remain available in Pi.

The inbox permits 20 pending messages, 2,000 retained receipts and 100 explicit retries per receipt. Settings show the latest 30 records. Each outgoing attachment has its own receipt and retry state, so an uncertain media send never automatically resends the text or other attachments. Local checks use synthetic provider responses and a real native SQLite runtime; they do not prove a live Meta connection. Consequential choices and release evidence are recorded in [the channel decision log](docs/decisions/agent-whatsapp.md) and [the image decision log](docs/decisions/whatsapp-images.md), and [the voice decision log](docs/decisions/whatsapp-voice.md).

## Reusable skills

**Skills → Import → From Executor** reads the `skills` tool from a ready connection. Choose an app, preview its pinned SKILL.md, then save a private local copy. The library keeps immutable revisions; each bot stays on the version you selected until you explicitly update it. Source details remain visible through edits and history restoration. Provider updates never silently replace saved instructions.

Imports copy only the main SKILL.md, with a 16,000-character limit. Reference filenames and the provider's app, deployment, revision and profile are retained as bounded source metadata. To let a bot read those references, select that connection's `skills` tool in **Connections** and review its policy in **Tool access**. Saving a skill never grants access. Imported copies remain usable after disconnecting; reading provider references requires an available connection. Source labels identify where a copy came from, not a signature that its text has remained unedited.

## Browser workbench

Open **Workbench → Browser → Browser internet settings** beside a bot. Choose allowed sites (up to 20 exact hostnames, HTTPS only), or enable **Unrestricted internet access** for public HTTP(S) sites without a hostname allowlist. Save the settings to apply them. Changing the policy closes the previous session and clears its preview. Its private Cloudflare Chromium session returns bounded text/links and captures screenshots. The bot's `browser_open`, `browser_read` and `browser_interact` tools use the same session and ask for approval by default. Page content is untrusted data, never permission or instructions.

Sessions expire after two idle minutes or ten minutes total. **Close session** revokes pending work and clears the preview; hiding the panel leaves the session until expiry. Changing destinations retires the previous session. Archiving also schedules cleanup. Session handles never enter browser JSON or model context. Screenshots require the authenticated owner and exact current capture version.

When unrestricted access is off, Cloudflare session guardrails restrict HTTP/HTTPS connections to configured hosts plus its maintained `common-cdns` asset set. Startup verifies a blocked destination and fails closed if enforcement is unavailable. In that mode, top-frame redirects are additionally restricted to exact owner-listed HTTPS hosts. Unrestricted mode omits these hostname guardrails while retaining public-hostname HTTP(S) URL validation. Text extraction runs in an isolated JavaScript world and is validated again in the Worker. The bot can click, type, press supported keys and scroll; each action uses a recent capture version, and uncertain outcomes require a fresh inspection before another action.

Choose **Take control** to pause bot browser tools. Click the screenshot to focus a field, or use **Tab field**, then the private **Type** input. **Return control** keeps the same Chromium session and cookies. Close revokes it. Owner command inputs do not enter chat or tool receipts; captures mask editable field values and omit them from extracted text. Sites can independently display submitted text elsewhere on a page, which can appear in subsequent observations. Complete sign-in and navigate away from sensitive pages before returning control. Typing into embedded frames and closed custom controls is refused until those contexts can be masked safely; use a standard input on the site’s own sign-in page. Arbitrary scripts and browser warning bypasses are not supported. Captures are snapshots, not a live video stream.

`node --env-file=.env --import tsx scripts/check-browser.ts` tests the local synthetic owner with real Cloudflare Chromium. It requires `OWNER_EMAIL=workspace-test@example.com` and the local test account; it never uses production owner credentials. `scripts/check-browser-control.ts` additionally verifies native interactions on Selenium’s public demonstration form, takeover/return, and a synthetic cookie across handoff.

## Code workbench

Open **Workbench → More workbench tools (⋯) → Code** beside a bot, enter JavaScript and JSON input, then choose **Run code**. Use `input`, `console.log`, and `return`. The private Dynamic Worker receives only that explicit input: no network, filesystem, application bindings or model credentials. The bot's `run_code` tool uses the same execution context and asks for approval by default.

Each bot retains code, input, output and status for up to 500 runs; the panel shows the latest 50. Repeating a request with its original ID reuses its result. Restarted incomplete runs become **interrupted**, without automatic re-execution. **Cancel run** commits cancellation and ignores late output. Inspect an uncertain result before starting another run.

Limits: 16,384 code characters, 32,768 input/result characters, 16,000 log characters, one active run, one second of CPU, and ten seconds elapsed. Cloudflare's native isolation and CPU limits are configured at the Worker Loader boundary; the host also limits untrusted response bytes and rejects redirects. This JavaScript runtime is separate from the Linux terminal.

`node --env-file=.env --import tsx scripts/check-execution.ts` checks the synthetic local owner against native workerd, including isolation, replay, cancellation, output limits and elapsed deadlines. Production CPU enforcement belongs to [Dynamic Workers resource limits](https://developers.cloudflare.com/dynamic-workers/usage/limits/); local tests do not claim a production CPU-exhaustion probe.

## Repository and data boundaries

This repository contains code and placeholder configuration. `.env*`, `.alchemy`, `.research`, local login identity, credentials, and databases are ignored. Run `node --env-file=.env --import tsx scripts/check-secrets.ts` before publishing: it checks tracked paths, common credential formats, and exact private configuration values without printing those values. It is a guardrail, not a substitute for reviewing the diff.

The public browser bundle contains no model credentials. Chat history, memory, authentication records, and refreshed credentials are private Cloudflare runtime data. Local test accounts are disposable and separate from production. The initial UI shows the latest 100 turns; older messages remain searchable and available through `zoom`.

## Private generated apps

Open **Workbench → Apps** for a bot's private apps. Ask the bot to make a table, form or custom app. For a project checklist, use **Checklists → New checklist**; it uses the same durable object operations as the agent's checklist tools. Saving creates an immutable draft; publishing a saved version makes its controls usable. The bot asks before publishing by default. Completed publication tool calls also expose the app inline in the conversation. Everything remains behind owner authentication; no public app links are created.

Checklists and forms save their state and queue an update to the owning bot. Updates wait while its model connection is unavailable and enter the normal conversation queue with the same tool approvals. Versions retain state only for matching component/item IDs. The version menu can preview or republish older definitions; it does not restore historical form answers. Archive disables interaction, and Restore makes the app usable again.

Unsaved form edits stay on the version you opened. If app state changes in another view, choose **Use saved values** or **Keep my edits** before submitting. An unconfirmed request can be retried with the same identity, or resolved before a different change.

Apps support text, metrics, tables, checklists and forms, or one custom web block. A custom app runs its JavaScript on the private Cloudflare execution Worker with only its own JSON state and the submitted action. It returns HTML, CSS and next state. Previewing never saves returned state; a published owner interaction atomically saves state and queues an update to the bot.

Custom HTML is parsed into a closed set of semantic elements and controls. It renders in an opaque sandboxed frame with a trusted form/button bridge; generated JavaScript never runs in the browser. Scripts, external resources, embedded frames, navigation, credentials and parent bindings are unavailable. Apps can build custom layouts and stateful forms; client frameworks, CDN dependencies and arbitrary browser JavaScript are outside this runtime.

Limits are 50 apps per bot, 50 versions per app, 20 pending updates and 2,000 app mutation/cancellation receipts per bot. Custom apps have 16,000-character code, 8,000-character JSON state, 12,000-character HTML and 4,000-character CSS limits. Each render/action has a one-second CPU and ten-second elapsed budget; one runs per bot at a time. External changes require an explicit reload so unsent fields are not silently overwritten. Archival, cancellation or a concurrent revision change prevents a late computation from saving.

## Linux command workbench

Open **Workbench → Terminal**, enter a shell command, and choose **Run command**. Node and Python run in a private Cloudflare container with outbound networking disabled by default. Open **Terminal internet settings**, enable **Unrestricted internet access**, and save to allow downloads, package installs, and other outbound traffic for this bot. This also applies to its interactive terminal. Stop or save an active session and wait for cleanup before changing the setting; each new command uses the saved policy. The bot's `run_command` tool asks for approval by default. The app and model credentials remain outside the container. The **Commands** tab runs bounded commands; **Interactive** opens a native shell with streaming input/output, resize, Ctrl+C and reconnect.

Each command starts from the last private R2 checkpoint of `/workspace`, saves a new checkpoint, then destroys its container and all child processes. Files outside `/workspace`, `node_modules`, `.git` and `.cache` are not retained. Commands share files but not running processes or shell environment. A nonzero exit can still save changed files. Stop, timeout, a failed checkpoint or an interrupted runtime keeps the previous checkpoint. Commands are never automatically repeated after a restart. **Retry same request** reuses its saved ID; new commands need a new ID.

Limits: 30 seconds including startup and saving, 16,000 command characters, 64,000 output characters, 8 MiB compressed checkpoint, one active command per bot, four concurrent container instances for the application. The history retains 500 commands; the latest 20 summaries are listed. If cleanup cannot be confirmed, new commands stay blocked until **Retry cleanup** succeeds. Command output is decoded as UTF-8; file bytes are preserved in checkpoints.

Local development requires Docker. Production uses Sandbox 1.0.1 with a native Durable Object, its own namespace, and a pinned container image. The runtime starts the supported `standard-1` size. A persistent capacity coordinator admits at most four containers across terminal commands, interactive sessions, and video extraction. It releases a permit after confirmed teardown; a timeout alone does not free a slot. Containers stop after 60 seconds of inactivity, and container logs are disabled.

Run `pnpm dev:sandbox` and, in another terminal, `pnpm test:sandbox` to check the native runtime with isolated local workerd, Docker, and R2 state. The checks cover commands, UTF-8, checkpoint restoration, request replay, per-bot isolation, denied internet access, Stop/rollback, native PTY resize/Ctrl+C/reconnect, Save/Discard, and video decoding.

The hosted migration fixture lives in `stacks/sandbox-hosted-rehearsal.ts`. Deploy it with a separate stage and a private `SANDBOX_REHEARSAL_TOKEN`, then set `SANDBOX_REHEARSAL_URL` to its output URL and run `node scripts/check-sandbox-migration.mjs`. Set `NATIVE_SANDBOX_URL` to that URL with `/native` appended to run `scripts/check-native-sandbox.mjs`. Both scripts read the token from the environment. Destroy the rehearsal stack after checking it. The 0.12.10 SDK alias and matching image are development fixtures for reproducing a populated migration; production agents do not use them.

Migration freezes new legacy work, drains active operations, and seals the source before writing bounded, checksummed pages to private R2. Resumable imports preserve authority, policy, command history, cancellation fences, checkpoints, and exported files. Verify destination row counts and file checksums before retiring source authority or changing the agent binding. Cross-check namespace listings against container history to discover legacy actors. Preserve the private workspace bucket and migration snapshots through cutover. See [Cloudflare's migration guide](https://developers.cloudflare.com/sandbox/sdk/migrate/).

`node --env-file=.env --import tsx scripts/check-terminal.ts` exercises real local workerd/Docker and private local R2 using a synthetic account. The account-scoped CI token in `stacks/github.ts` includes Workers Containers read/write access; credentials stay outside the repository.

### Interactive terminal

Choose **Interactive → Open interactive terminal**. Only this session can use the bot's Linux workspace until it closes. **Save and close** retains `/workspace` in a private checkpoint; **Discard and stop** keeps the previous checkpoint. Check the visible result: a failed save does not retain changes. The terminal transcript is not added to conversation history.

The workbench renews a thirty-second authenticated lease; switching its internal tabs or changing screen size preserves it. Closing the whole workbench, revoked sign-in or a sustained connection failure stops the session without saving. A session ends after ten minutes regardless of renewal. Only one viewer connects at a time. Input is bounded to 256,000 bytes and output/replay to 4 MiB; reconnect can replay the native 256 KiB terminal buffer. Clipboard and link addons are not installed.

`node --env-file=.env --import tsx scripts/check-interactive-terminal.ts` checks the native shell and checkpoint lifecycle using the synthetic local owner, including resize, keyboard interruption, full-buffer reconnect and logout expiry. The image-local shell launcher runs under a native PTY; tmux preserves the shell across viewer reconnects.

### Private file transfer

In **Terminal → File transfer**, choose **Copy from Files** to place a selected private asset in a new `/workspace/imports/<transfer-id>/` folder. Its completed path is shown in the result. The next command restores that checkpoint. Transfers never overwrite a file, follow symlinks, or read outside `/workspace`.

To retrieve a generated file, enter its absolute `/workspace/...` path and choose **Prepare export**. Save an interactive shell first: exports read the saved checkpoint. Download the completed export directly, or choose **Add exported file to Files** to prepare previews and attach it to chat. Files must be regular, non-empty and at most 8 MiB. The library's supported-format and quota rules still apply; the direct download preserves the original bytes.

An unconfirmed request retains its transfer ID. **Retry transfer** recovers that receipt even after the source is renamed or trashed. **Cancel transfer request** records cancellation before allowing a corrected request; delayed submissions of the canceled ID cannot execute. Failed imports keep the previous checkpoint, and exports never replace it.

`node --env-file=.env --import tsx scripts/check-terminal-files.ts` exercises the native private-file boundary with the synthetic local owner, including fresh restore, exact bytes, replay, cancellation, isolation and special-file rejection.

## Scheduled routines

Open **Workbench → More workbench tools (⋯) → Routines** to schedule work for the current bot, or ask the bot to create a routine. Scheduling through the bot asks for approval by default. Choose a one-off time or an elapsed-time interval; repeats continue on Cloudflare while the browser is closed. The editor shows your local timezone. Repeats are not calendar rules, so they follow elapsed time across daylight-saving changes.

Results appear in the bot's conversation under its current tool permissions. Only one routine waits or runs at once; missed intervals become one run, and each admitted run has a ten-minute budget. A disconnected model leaves the run waiting. **Pause** prevents future work; **Stop run** also stops a run already queued or running. **Archive** is recoverable through **Restore paused**. A completed one-off schedule can be run again with **Run now** or edited to a new future time.

If another view changes the routine while you edit, choose **Keep my edits** or **Use saved values**. If a save is unconfirmed, retry the same change or resolve it before navigating away. The app does not send email/push notifications automatically. Authenticated incoming webhooks are described below. Calendar/timezone recurrence remains separate work.

### Incoming events

Open a routine's **Webhook** settings to create a private key, or choose **Events** when creating a routine that should only run on demand. POST a JSON object to the displayed endpoint with `Authorization: Bearer YOUR_KEY`, a unique `X-Event-Id`, and `Content-Type: application/json`. Keys are shown only when created and stored only as hashes; rotate a lost key. Never put a key in a URL or chat.

Both raw and normalized JSON must fit 16 KB. A 202 response accepts a durable run; repeating the same event ID and data returns 200 with the same run ID. A 429 response means the bot already has a routine waiting/running: retry after 60 seconds with the same ID. Retry 503 responses with the same ID. A 409 response requires attention (paused routine, reused ID with different data, or capacity reached). Receipts are capped at 2,000 per bot and never silently evicted. Vendor-specific signatures require a trusted adapter at the sender.

Keys are opt-in; no external service receives one automatically. Rotating/disabling a key cancels waiting webhook work, while an admitted reply can finish unless stopped. Event data cannot grant tool permissions; normal bot approvals and the ten-minute budget apply. Results appear in the conversation.

## Automatic file preparation

PDFs and videos can be sent before extraction finishes. The request retains its original identity, route and files across restarts; cancellation prevents it from starting later. Unreadable files produce a specific error rather than an incomplete model answer. Existing stored binary documents remain available for sharing, without claiming their contents were extracted. See [the preparation decisions](docs/decisions/attachment-preparation.md).

## Video attachments

Upload an MP4 or WebM in **Files** or the composer. Preparation runs in an isolated Cloudflare container and stores up to six timestamped JPEG frames plus any supported embedded text captions in private R2 storage. **Preview** shows what can enter the model context. Attach and send while preparation is running: the original request waits durably and starts automatically when its files are ready. Email uses the same pipeline; WhatsApp document/video intake remains a separate adapter slice. Missing preparation jobs are queued automatically; failed preparation is reported in the originating conversation and can be retried explicitly.

Limits: 8 MB, ten minutes, 4096 pixels per side, six frames of at most 24 KB each, and 8,000 UTF-16 units of captions. Sampled frames omit movement and events between them. Audio is not transcribed; image-based subtitles are not read with OCR. Complex or damaged clips may exceed the decoding limit. Originals remain available for download.

Video preparation uses a separate container identity from the interactive terminal, with no outbound network or model credentials. Preparation and terminal sessions share the existing four-container capacity. A temporary capacity failure retries up to three times with a persisted delay. Trash/archive pauses preparation and prevents publishing or attaching its results until restored.

## Formatting, linting and complexity

Run `pnpm format` to apply Oxfmt and `pnpm lint:fix` for safe lint fixes. `pnpm verify:static` checks formatting, types, lint, migration integrity and secrets. Oxfmt retains the existing semicolon-free style, orders imports without reordering side-effect imports, and sorts Tailwind classes in JSX, `cn` and `cva` using `src/styles.css`.

[Ultracite](https://www.ultracite.ai/) supplies selected correctness and TypeScript safety rules. Its React preset runs across the frontend, including Hooks dependency and accessibility checks. The native TanStack preset and React Doctor add-on check Start server-function validation, mutation methods, loader safety and route ordering, alongside Router and Query conventions. [Effect's native diagnostics](https://github.com/Effect-TS/tsgo) check yielded Effects, errors, requirements, services and layers through patched Oxlint. Domain errors must stay typed; adapters and fault-injection tests may carry unknown native failures before interpreting them. The compiler and Oxlint versions are pinned as a supported set, patched idempotently by `pnpm install`, and grouped for Renovate upgrades. `pnpm typecheck` owns TypeScript diagnostics; Oxlint owns Effect diagnostics to avoid duplicate reports.

The selected community [Effect lifecycle rules](https://github.com/cevr/oxlint-plugin-effect) reject eager acquisition, nested managed runtimes, per-call caches, unbounded retries or concurrency, and collection of unbounded streams. Effect's `Context.Service`, `Schema.Class` and `Schema.TaggedError` classes are supported. Branding, service `.of` wrappers, mandatory named `Effect.fn` wrappers and blanket runtime prohibitions are not imposed. Async React and native event callbacks keep their existing contracts. Existing architecture, restricted-import and scoped cycle checks remain in force.

React component syntax and handler naming remain flexible. Memo wrappers and native-tag substitutions are not required for valid live regions and composite widgets. The incomplete React Compiler diagnostics are explicitly disabled where they reject supported try/finally, dynamic imports, schemas or mutable request lifetimes; the Hooks dependency checker remains enabled. Intentional request-generation invalidation and the reconnect transport key have local, explained exceptions.

Oxlint enforces classic cyclomatic complexity **20** for source, scripts and tests, with no legacy waivers. [cccc](https://github.com/moznion/cccc) reports cognitive and cyclomatic complexity separately: install its official **v1.8.3** release, then run `pnpm complexity:report` for JSON or `cccc --top-cognitive 25 --table src` for a table. CI verifies the reporter through its pinned setup action, adds the top cognitive hotspots to the check summary, and retains the complete JSON report for 14 days. cccc is informational; Oxlint provides the complexity gate.

### Task controls across agents and surfaces

Each agent can use `list_tasks` to inspect unfinished requests, bot-to-bot tasks and background groups across the account, and `stop_task` to stop one exact task. The same existing tool permissions apply. Request-owned research stops with its parent request.

Email and WhatsApp accept `STATUS`, `STATUS all`, `STATUS <agent slug>` and `STOP <handle>` as the first line. WhatsApp also accepts slash prefixes. Copy the stable task handle returned by status; it identifies the original agent and task even after an agent is renamed. These commands run while the model is busy. A stop acknowledgement records cancellation intent and reports its saved state; it cannot undo completed actions. Approvals keep their existing controls.
