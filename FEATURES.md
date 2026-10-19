# Durable Pi feature map

Durable Pi is a private workspace of persistent personal agents. You can talk to an agent, give it tools, retain files and memory, maintain saved work, and inspect or stop its tasks. Web, email, and WhatsApp connect to the same agent capabilities where their adapters support them.

This map covers **27 feature areas and 155 behaviors**, checked against main revision `a133e4b93452694bf5d5aef0f3129ac4f662073e` on **October 19, 2026**. It describes implemented behavior and explicit gaps. It does not claim that every journey was exercised in production during this documentation pass.

Open [Durable Pi](https://bot.cill-i-am.com), use the inventory below to find a feature, and follow its recipe to verify it. The [verification skill](.cursor/skills/verify-durable-pi/SKILL.md) provides launch, readiness, evidence, and cleanup instructions. The [architecture guide](docs/architecture.md) explains domain ownership separately.

## Capability map

Each linked page gives sub-features, every mapped entry point, a drive recipe with observable results, and prerequisites or limitations.

| Area | Feature | What you can do |
| --- | --- | --- |
| Workspace | [Workspace](.cursor/skills/verify-durable-pi/features/workspace.md) | Find agents, open saved views, preserve drafts and readable URLs. |
| Workspace | [Account security](.cursor/skills/verify-durable-pi/features/accounts.md) | Passwords, passkeys, authenticator codes, sessions, and profile photo. |
| Workspace | [Family and model access](.cursor/skills/verify-durable-pi/features/family.md) | Invitation-only private workspaces and the shared ChatGPT connection. |
| Workspace | [Persistent agents](.cursor/skills/verify-durable-pi/features/agents.md) | Create, configure, rename, archive, restore, and resolve ID/slug links. |
| Agent work | [Conversations](.cursor/skills/verify-durable-pi/features/chat.md) | Streaming, steering, queued input, cancellation, and reconnect. |
| Agent work | [Models and context](.cursor/skills/verify-durable-pi/features/models.md) | Per-message/job choices, pinned routes, compaction, and usage. |
| Agent work | [Task plans](.cursor/skills/verify-durable-pi/features/plans.md) | Objectives, steps, blockers, evidence, and revision history. |
| Knowledge and files | [Memory](.cursor/skills/verify-durable-pi/features/memory.md) | Originals, search, summaries, sourced notes, import/export, and backups. |
| Knowledge and files | [Files and images](.cursor/skills/verify-durable-pi/features/files.md) | Private library, original bytes, attachment selection, and sharing. |
| Knowledge and files | [Voice notes](.cursor/skills/verify-durable-pi/features/audio.md) | Recording, original playback, transcription, and text replies. |
| Knowledge and files | [Documents and video](.cursor/skills/verify-durable-pi/features/documents-video.md) | PDF text, sampled video frames, and durable preparation. |
| Communication | [Email](.cursor/skills/verify-durable-pi/features/email.md) | Owner-inbox conversations, files, explicit approval replies, and revocation. |
| Communication | [WhatsApp](.cursor/skills/verify-durable-pi/features/whatsapp.md) | Implemented text/media adapter; live onboarding remains parked. |
| Communication | [Reply delivery](.cursor/skills/verify-durable-pi/features/replies.md) | Complete text/files, multipart progress, and conservative retries. |
| Communication | [Cross-agent task controls](.cursor/skills/verify-durable-pi/features/tasks.md) | Account-wide status and exact-target stop, including busy channels. |
| Saved work | [Interactive answers](.cursor/skills/verify-durable-pi/features/rich-answers.md) | Tables, maps, forecasts, products, comparisons, and draft questions. |
| Saved work | [Reusable skills](.cursor/skills/verify-durable-pi/features/skills.md) | Private library, immutable revisions, per-agent pins, and import. |
| Saved work | [Project checklists](.cursor/skills/verify-durable-pi/features/checklists.md) | Live chat/workbench edits, conflicts, history, and archive. |
| Saved work | [Private apps](.cursor/skills/verify-durable-pi/features/apps.md) | Versioned private interfaces, saved state, and correlated events. |
| Tools and environments | [Tools and approvals](.cursor/skills/verify-durable-pi/features/tools-approvals.md) | MCP/Executor connections, policies, exact decisions, and revocation. |
| Tools and environments | [Agent browser](.cursor/skills/verify-durable-pi/features/browser.md) | Permitted websites, captures, interaction, and owner takeover. |
| Tools and environments | [JavaScript](.cursor/skills/verify-durable-pi/features/code.md) | Isolated code with explicit input, logs, saved result, and cancellation. |
| Tools and environments | [Linux terminal](.cursor/skills/verify-durable-pi/features/terminal.md) | Commands, interactive shell, saved workspace, and file transfer. |
| Autonomous work | [Routines and events](.cursor/skills/verify-durable-pi/features/routines.md) | One-off/interval schedules, run controls, and authenticated webhooks. |
| Autonomous work | [Temporary delegation](.cursor/skills/verify-durable-pi/features/delegation.md) | Request-owned research and tool-free background reports. |
| Autonomous work | [Named-agent communication](.cursor/skills/verify-durable-pi/features/bot-communication.md) | Bounded text tasks with correlated results and delivery recovery. |
| Visibility | [Activity and recovery](.cursor/skills/verify-durable-pi/features/activity.md) | Account/agent timelines, saved traces, partial reads, and specific recovery. |

## Surface coverage

The product direction is one set of agent capabilities with several surfaces. This table records adapter coverage, not a promise that the surfaces are already identical. **Adapter** means implemented and locally testable; it does not mean the provider is connected. Real-time remote-control interfaces still use web.

| Capability | Web | Email | WhatsApp |
| --- | --- | --- | --- |
| Normal questions and full text answers | Implemented | Implemented; owner inbox acceptance recorded separately | Adapter; live onboarding parked |
| Agent choice | Agent collection; ID/slug links | A private address per enabled agent | Selected route; `/agents` and `/agent AGENT_ID` |
| Images and selected reply files | Upload, inspect, download | MIME attachments in both directions | Images inbound; selected files outbound; provider limits apply |
| Voice notes | Record/upload, playback, transcript; text answer | Supported audio attachment intake; text answer | Voice-note adapter; text answer |
| PDFs and video | Shared preparation, preview, durable wait | Same preparation pipeline | Original-file export adapter; PDF/video intake not implemented |
| Long/multipart replies | Full saved answer/downloads | Full answer and threaded attachment batches | Split full text and separate file messages |
| Pi tool approvals | Full input card and explicit decision | Full readable card and signed APPROVE/DENY reply | Review link to authenticated Pi; chat decision not built |
| Executor approvals | Executor's authenticated approval page | Executor retains its own decision flow | Executor retains its own decision flow |
| Status and exact stop across agents | Natural-language tools plus original task controls | Leading STATUS/STOP commands bypass busy model queue | Same command adapter; live provider test blocked |
| Skills, plans, checklists, routines, and other agent tools | Tools plus relevant panels | Agent tools available under the same policies; panel UI does not travel in mail | Ordinary agent tools preserved; UI/card parity incomplete |
| Interactive answer cards and private apps | Implemented interactive renderers | Text/files; equivalent interaction renderer not built | Equivalent interaction renderer not built |
| Browser takeover and interactive terminal | Dedicated authenticated controls | No equivalent remote-control UI | No equivalent remote-control UI |
| Family participants | Separate private accounts/workspaces | Deployment owner only | One configured owner sender; participant mapping not built |
| TTS and real-time calls | Not built | Not applicable | Not built |

A channel does not reduce an ordinary agent's tool permissions. Explicitly restricted delegated recipients and temporary children keep their narrower grants. Being able to use an agent tool is separate from having a suitable channel renderer for its result.

## Consequential boundaries

- **Private people, separate agents.** Family membership shares the application and model connection. It does not share private agents, files, memory, approvals, or connected accounts. Cross-agent task control stays within the same person's account.
- **One durable request.** Input, files, model route, and skills retain their original identities through waiting and recovery. Reading Activity or reconnecting a browser does not submit the work again.
- **Files are first-class input and output.** The workspace owns originals and processing. Channels select and transport files; they do not invent separate stores or silently replace requested attachments with web links.
- **Exact approval and cancellation.** Pi decisions remain bound to an operation. Executor owns Executor decisions. Stop targets a stable task handle and reports settling work honestly; it cannot undo a completed external action.
- **Delivery has uncertainty.** Confirmed provider messages are checkpointed and skipped on retry. An ambiguous send needs an explicit decision before resend. Provider acceptance is distinct from recipient delivery.
- **The map is not an acceptance certificate.** Source, deterministic tests, native restart checks, browser fixtures, real-model behavior, and live provider acceptance are different kinds of evidence.

## Verification coverage and gaps

The [source register](.cursor/skills/verify-durable-pi/references/source-register.md) links all 27 feature areas to code and tests. The [proof record](.cursor/skills/verify-durable-pi/references/proof.md) records checks actually run while creating this map. Other detailed recipes are marked by their prerequisites; their presence does not mean they were executed in this pass.

Recorded channel decisions and prior acceptance evidence remain in [the decision records](docs/decisions) and [build history](BUILD.md). Refresh a deployment/provider state before treating an earlier observation as current.

The remaining gaps relevant to the product direction are explicit:

- WhatsApp provider onboarding and live message acceptance are parked. Its inbound parser accepts text, images, and audio; PDF/video intake still needs an adapter slice even though original-file export exists.
- WhatsApp approve/deny, shared clarification/continue/retry controls, and per-person channel routing remain separate slices.
- Interactive answer/app renderers and browser/terminal owner controls do not yet have equivalent non-web interaction flows.
- Speech output, real-time calls, native video inference, scanned-document OCR, and image-subtitle OCR are not built. Audio transcription is implemented.
- Routines do not automatically send email/push outcome notifications. Calendar/timezone recurrence and provider-specific webhook signatures are separate work.
- Private app sharing, additional working-object types, automatic memory dreaming, and full-account disaster recovery are not implemented.
- A stale open tab can fail to load an old lazy-loaded chunk after deployment. A full reload is the recorded workaround; automatic refresh recovery remains a follow-up.

These gaps describe scope; they do not add roadmap commitments. Use [maintain-verification-skill](https://github.com/cursor/plugins/blob/main/pstack/skills/maintain-verification-skill/SKILL.md) to audit the map when behavior changes. No new recurring automation is created by this document.
