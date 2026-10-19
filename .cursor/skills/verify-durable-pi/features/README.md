# Durable Pi verification map

This is the maintained user-journey map for Durable Pi. It covers **27 feature areas and 165 behavior IDs**, checked against source revision `a133e4b93452694bf5d5aef0f3129ac4f662073e` on **October 19, 2026**. Coordination/authorship and stale-tab/draft recovery entries were added by their later slices, with linked source and verification records. A listed recipe is not a claim that it passed in production.

For a product overview and cross-surface comparison, start with [FEATURES.md](../../../../FEATURES.md). For launch, health checks, evidence, and cleanup, read the [verification skill](../SKILL.md). The [source register](../references/source-register.md) links each area to its implementation and checks without mixing backend structure into the user journeys.

## Baseline preconditions

- Primary surface: the authenticated web app at [bot.cill-i-am.com](https://bot.cill-i-am.com). Email is the deployment owner's additional surface. WhatsApp provider onboarding is parked.
- Use an existing authorized account for real-app work. Family members have separate private agents and data. Do not assume the production owner is the only possible app user.
- The local browser fixture is disposable and uses synthetic auth, model, storage, and transport responses. Its fixture agent is **Navi**, ID `home`, slug `navi`.
- The real app requires configured auth and model access; particular features need their Cloudflare services, MCP authorization, or external provider setup. No fixture can establish those prerequisites.
- Run one browser verification session at a time on fixture port `4399`. The existing Playwright config refuses to reuse a server. Never stop an unrelated process to free the port.
- Keep traces and downloads under `/private/tmp/pi-feature-map-evidence-19oct` for this run, or another explicitly recorded private evidence directory. Do not commit private content or generated screenshots.

## Driving conventions

- Read the matching feature file before driving. Every file has the same four sections and short behavior IDs.
- Substitute a real visible slug for `AGENT_SLUG`. IDs remain valid inbound links and exact task handles; human-facing URLs canonicalize to slugs.
- Prefer role/name or associated-label selectors. Labels written in bold match visible controls; all-caps route placeholders are not literal agent identities.
- A `pnpm test` command exercises its named deterministic/native boundary. A `pnpm test:browser` command drives the real UI against the disposable fixture. Neither implies a real-model or provider test.
- Real-app recipe bullets are instructions for a browser-driving harness with authorized access. If no matching scripted journey exists, report a harness gap instead of claiming the unit test covers it.
- For real-model tests, ask naturally and inspect actual tool selection. A directly constructed card or synthetic model response proves presentation, not agent choice.
- Do not repeat a send/mutation when its acknowledgement is uncertain. Resolve its saved state or use the documented retry identity/confirmation.

## Proof and coverage reporting

For each attempt, record feature/behavior ID, source revision, surface, entry point, prerequisites, action, observed result, and artifact path. Use these result labels:

| Result | Meaning |
| --- | --- |
| Passed | The named recipe and observable end state were exercised on the stated surface. |
| Failed | The attempted journey reached an incorrect result. Keep the failure and its preconditions. |
| Blocked | A required credential, membership, provider, device, service, or seed state was unavailable. Name it. |
| Not run | Source was checked, but this journey was not exercised in this run. |

Capture the action and result, then independently reopen saved values or inspect actual side effects. UI proof includes a trace/screenshot with app identity. Files need byte/hash comparison when preservation matters. Channel proof needs actual sent/received provider messages. Acceptance by a provider is not delivery or reading.

Do not substitute another entry point for one that failed. Do not weaken a recipe to fit missing seed data. Record the missing prerequisite in Gotchas and retain the original failure.

## Features

- [Workspace](workspace.md): Find agents, open saved views, preserve drafts and readable URLs.
- [Account security](accounts.md): Passwords, passkeys, authenticator codes, sessions, and profile photo.
- [Family and model access](family.md): Invitation-only private workspaces and the shared ChatGPT connection.
- [Persistent agents](agents.md): Create, configure, rename, archive, restore, and resolve ID/slug links.
- [Conversations](chat.md): Streaming, steering, queued input, cancellation, and reconnect.
- [Models and context](models.md): Per-message/job choices, pinned routes, compaction, and usage.
- [Task plans](plans.md): Objectives, steps, blockers, evidence, and revision history.
- [Memory](memory.md): Originals, search, summaries, sourced notes, import/export, and backups.
- [Files and images](files.md): Private library, original bytes, attachment selection, and sharing.
- [Voice notes](audio.md): Recording, original playback, transcription, and text replies.
- [Documents and video](documents-video.md): PDF text, sampled video frames, and durable preparation.
- [Email](email.md): Owner-inbox conversations, files, explicit approval replies, and revocation.
- [WhatsApp](whatsapp.md): Implemented text/media adapter; live onboarding remains parked.
- [Reply delivery](replies.md): Complete text/files, multipart progress, and conservative retries.
- [Cross-agent task controls](tasks.md): Account-wide status and exact-target stop, including busy channels.
- [Interactive answers](rich-answers.md): Tables, maps, forecasts, products, comparisons, and draft questions.
- [Reusable skills](skills.md): Private library, immutable revisions, per-agent pins, and import.
- [Project checklists](checklists.md): Live chat/workbench edits, conflicts, history, and archive.
- [Private apps](apps.md): Versioned private interfaces, saved state, and correlated events.
- [Tools and approvals](tools-approvals.md): MCP/Executor connections, policies, exact decisions, and revocation.
- [Agent browser](browser.md): Permitted websites, captures, interaction, and owner takeover.
- [JavaScript](code.md): Isolated code with explicit input, logs, saved result, and cancellation.
- [Linux terminal](terminal.md): Commands, interactive shell, saved workspace, and file transfer.
- [Routines and events](routines.md): One-off/interval schedules, run controls, and authenticated webhooks.
- [Temporary delegation](delegation.md): Request-owned research, continuing agent sessions, and tool-free background reports.
- [Named-agent communication](bot-communication.md): Bounded text tasks with correlated results and delivery recovery.
- [Activity and recovery](activity.md): Account/agent timelines, saved traces, partial reads, and specific recovery.
