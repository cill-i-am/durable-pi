# Durable Pi

A private, continuous web chat built with **Pi Durable**, Cloudflare Durable Objects, **TanStack Start**, **shadcn/ui on Base UI**, Better Auth, and **Alchemy Effect**.

Production: [bot.cill-i-am.com](https://bot.cill-i-am.com). Alchemy attaches this hostname to the existing website Worker and manages its DNS and TLS certificate. The production zone is pinned in `alchemy.run.ts`; development keeps its local URL. `Worker.URL` supplies the canonical origin to authentication. The previous `workers.dev` address redirects page requests to this address; mutations require the canonical origin. Sign in again on the new hostname using the existing account.

Pi owns model turns, tool execution, committed transcripts, and recovery. The application adds an owner-only login, a durable submission queue, a lossless message archive, a binary summary tree, and sourced Markdown memory notes. ChatGPT subscription access uses Pi's current OpenAI sign-in flow.

## Run it

Requires Node 24+ and pnpm 12.4.2. Install with `pnpm install --frozen-lockfile`.

1. Copy `.env.example` to `.env`. Set `OWNER_EMAIL`, and generate separate random values of at least 32 bytes for `BETTER_AUTH_SECRET` and `SETUP_TOKEN`. Keep `.env` private.
2. Run `pnpm model:login`. Complete the official ChatGPT login in your browser. The script writes the credential to `.env` with mode `0600`; it never prints tokens.
3. Run `pnpm dev`. Alchemy emulates the Workers, Durable Object, and D1 locally. The app URL appears in the output.
4. Open the app, choose **First time? Set up your account**, and enter your private setup key and a password. Only the configured owner's email can be registered. Registration closes once that account exists.

`pnpm verify` runs route generation, type checking, unit tests, and the browser/server build. `pnpm lint` checks source. Neither needs provider credentials. `pnpm run deploy` provisions the production stage through Alchemy using the explicitly configured profile. A Cloudflare account with Workers, D1, and R2 permissions is required; hosting charges are separate from ChatGPT model usage.

Production uses the dedicated `durable-pi` Alchemy profile. Configure it with `pnpm exec alchemy profile create durable-pi` and `pnpm exec alchemy profile edit --profile durable-pi`, selecting Workers scripts read/write, D1 read/write, Workers R2 Storage read/write, account settings read, memberships read, and user details read. OAuth adds offline refresh access. A fresh machine also needs Secrets Store read/write to retrieve remote-state credentials; an existing trusted state-credential cache avoids that additional local permission.

The compatibility date matches Alchemy beta.81's bundled local workerd (`2026-09-25`). Local development keeps infrastructure state under ignored `.alchemy/state`; deployments share the encrypted Cloudflare state service. Use a separate ChatGPT login for independently running deployments: OAuth refresh tokens rotate.

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

- One private chat, queued messages, committed response updates, stop, retry-safe submission IDs, and reopening after a restart.
- One fresh Pi conversation per user turn. Prior context is a bounded summary view, with `zoom` and `date` tools to recover original messages.
- The reference compaction prompt, a 512-byte scale example, five byte-feedback attempts, eight concurrent compactions with a source-order barrier, and durable ten-second retries. Aligned binary merges preserve an incremental view that never splits.
- Exact archive search, private Markdown notes with source message IDs and revision history, and a memory inspector.
- Better Auth sessions backed by D1. An authenticated server route forwards to a Worker with both public and preview URLs disabled. The Durable Object is addressed only from the authenticated owner ID.
- Server-side ChatGPT credentials with serialized refresh and durable token rotation. API-key credentials are also supported through the same private configuration.

The first version can remember, retrieve, reason, and draft. External apps, shell/browser execution, attachments, messaging channels, and scheduled autonomous tasks are not connected.

## Memory design

[Victor Taelin's OptChat specification](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449) defines the memory behavior:

- Every committed user message, reply, tool call, and tool result is archived verbatim. Reasoning stays in Pi's private transcript and is excluded from the searchable memory archive. Previous releases capped very large tool-result projections; those historical projections are retained as written.
- Summary nodes target 512 UTF-8 bytes. Short sources are copied without a model request; longer ones use the reference prompt and up to five attempts in the same conversation. The shortest result is retained even if still oversized, as the specification requires.
- A lifecycle job runs up to eight ready summaries, refilling slots on completion. Original messages remain sequential; ready merges run alongside them. Each failed node persists a ten-second retry deadline and reports its first failure without logging provider content.
- The 128,000-byte view merges only aligned, built siblings using `(total - start) / (count * 4)`. The view is captured before appending the next user message and never splits old ranges. SQLite transactions replace file locks and fsync; the view is persisted across restarts.
- Each turn has a fresh Pi session. The system prompt and tools stay constant. The memory view is a separate content block with explicit cache breakpoints before the 50,000, 80,000, and 100,000-character line boundaries. Requests use a stable owner-specific cache key, `store: false`, and `reasoning.context: all_turns`; Pi retains encrypted reasoning and tool replay. No long-retention or cache-renewal requests are made. The Files tab reports actual cached/input usage; short histories may have no cache hits.
- The memory inspector opens summaries down to original messages. Authenticated exports stream a linked, script-free HTML archive or JSONL with the log, tree, view, and note revisions.

Incoming messages during a running response remain durably queued for a fresh turn; mid-tool steering is not implemented. Optional OptChat subagents are not connected. These are explicit differences from the reference, rather than hidden memory omissions.

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

## Repository and data boundaries

This repository contains code and placeholder configuration. `.env*`, `.alchemy`, `.research`, local login identity, credentials, and databases are ignored. Run `node --env-file=.env --import tsx scripts/check-secrets.ts` before publishing: it checks tracked paths, common credential formats, and exact private configuration values without printing those values. It is a guardrail, not a substitute for reviewing the diff.

The public browser bundle contains no model credentials. Chat history, memory, authentication records, and refreshed credentials are private Cloudflare runtime data. Local test accounts are disposable and separate from production. The initial UI shows the latest 100 turns; older messages remain searchable and available through `zoom`.

The Effect and Alchemy skills under `.agents/skills` come from [cill-i-am/skills](https://github.com/cill-i-am/skills).
