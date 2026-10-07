# Durable Pi

A private, continuous web chat built with **Pi Durable**, Cloudflare Durable Objects, **TanStack Start**, **shadcn/ui on Base UI**, Better Auth, and **Alchemy Effect**.

Pi owns model turns, tool execution, committed transcripts, and recovery. The application adds an owner-only login, a durable submission queue, a lossless message archive, a binary summary tree, and sourced Markdown memory notes. ChatGPT subscription access uses Pi's current OpenAI sign-in flow.

## Run it

Requires Node 24+ and pnpm 12.4.2. Install with `pnpm install --frozen-lockfile`.

1. Copy `.env.example` to `.env`. Set `OWNER_EMAIL`, and generate separate random values of at least 32 bytes for `BETTER_AUTH_SECRET` and `SETUP_TOKEN`. Keep `.env` private.
2. Run `pnpm model:login`. Complete the official ChatGPT login in your browser. The script writes the credential to `.env` with mode `0600`; it never prints tokens.
3. Run `pnpm dev`. Alchemy emulates the Workers, Durable Object, and D1 locally. The app URL appears in the output.
4. Open the app, choose **First time? Set up your account**, and enter your private setup key and a password. Only the configured owner's email can be registered. Registration closes once that account exists.

`pnpm verify` runs route generation, type checking, unit tests, and the browser/server build. `pnpm lint` checks source. Neither needs provider credentials. `pnpm run deploy` provisions the production stage through Alchemy using the explicitly configured profile. A Cloudflare account with Workers and D1 permissions is required; hosting charges are separate from ChatGPT model usage.

Production uses the dedicated `durable-pi` Alchemy profile. Configure it with `pnpm exec alchemy profile create durable-pi` and `pnpm exec alchemy profile edit --profile durable-pi`, selecting Workers scripts read/write, D1 read/write, account settings read, memberships read, and user details read. OAuth adds offline refresh access.

The compatibility date matches Alchemy beta.81's bundled local workerd (`2026-09-25`). Local development keeps infrastructure state under ignored `.alchemy/state`; deployments share the encrypted Cloudflare state service. Use a separate ChatGPT login for independently running deployments: OAuth refresh tokens rotate.

## Automatic deployments

Following [Alchemy's CI guidance](https://alchemy.run/environments/ci/), `.github/workflows/check.yml` deploys production after verification passes on a push to `main`. Pull requests run checks without deployment credentials. The GitHub `production` environment is restricted to `main`; production deploys are serialized and never canceled halfway through. A post-deploy check verifies the homepage and anonymous access restrictions.

`stacks/github.ts` is a separate, manually deployed setup stack. It creates an account-scoped Cloudflare deploy token and writes the application configuration to encrypted GitHub environment secrets. The token has Workers Scripts read/write, D1 read/write, Account Settings read, and Secrets Store read permissions. It cannot create further API tokens. Only the setup stack uses an administrator profile:

```sh
CLOUDFLARE_ACCOUNT_ID=your-account-id pnpm exec alchemy deploy \
  --config stacks/github.ts --stage production --profile your-admin-profile
```

CI resolves credentials from environment secrets, not the local OAuth profile. Its token can access the existing Alchemy state service; creating or upgrading that service is a separate administrator operation. Keep the setup stack's state private, and rerun setup to rotate configuration or permissions.

For the initial local-to-remote state migration, `scripts/migrate-production-state.ts` copies only this app's production records, rejects conflicting remote records, verifies each write, and retains the local backup. Run it without `--apply` first. Never switch an existing deployment to an empty state store.

## What is implemented

- One private chat, queued messages, committed response updates, stop, retry-safe submission IDs, and reopening after a restart.
- One fresh Pi conversation per user turn. Prior context is a bounded summary view, with `zoom` and `date` tools to recover original messages.
- UTF-8 summary sizes, source-order compression, aligned binary merges, an incremental view that never splits, and fixed-delay recovery when summarization fails.
- Exact archive search, private Markdown notes with source message IDs and revision history, and a memory inspector.
- Better Auth sessions backed by D1. An authenticated server route forwards to a Worker with both public and preview URLs disabled. The Durable Object is addressed only from the authenticated owner ID.
- Server-side ChatGPT credentials with serialized refresh and durable token rotation. API-key credentials are also supported through the same private configuration.

The first version can remember, retrieve, reason, and draft. External apps, shell/browser execution, attachments, messaging channels, and scheduled autonomous tasks are not connected.

## Memory design

[Victor Taelin's OptChat specification](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449) informs the archive and summary tree. SQLite transactions replace file locks and fsync. The incremental view is persisted instead of reconstructed. Summarization runs in bounded sequential batches under a Cloudflare lifecycle job rather than eight concurrent processes. Original model/tool messages remain in Pi storage; reasoning is excluded from the application's searchable archive and memory summaries. Large tool results are capped only in the memory projection.

[Cognition's Agent Memory Repo](https://cognition.com/agent-memory-repo) informs the linked, sourced Markdown notes. Here those notes and their revisions stay in private SQLite. They are never pushed to the public source repository. Automatic scheduled “dreaming” is not enabled.

[Sawyer Hood's Pi Durable demo](https://x.com/sawyerhood/status/2107872386339287239) informed the standalone hosted-chat direction. [Whirl](https://github.com/whirlchat/whirl) informed the compact composer interaction; its Convex-dependent composer is not embedded. The UI uses native shadcn Base UI source components.

## Repository and data boundaries

This repository contains code and placeholder configuration. `.env*`, `.alchemy`, `.research`, local login identity, credentials, and databases are ignored. Run `node --env-file=.env --import tsx scripts/check-secrets.ts` before publishing: it checks tracked paths, common credential formats, and exact private configuration values without printing those values. It is a guardrail, not a substitute for reviewing the diff.

The public browser bundle contains no model credentials. Chat history, memory, authentication records, and refreshed credentials are private Cloudflare runtime data. Local test accounts are disposable and separate from production. The initial UI shows the latest 100 turns; older messages remain searchable and available through `zoom`.

The Effect and Alchemy skills under `.agents/skills` come from [cill-i-am/skills](https://github.com/cill-i-am/skills).
