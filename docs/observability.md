# Investigating Durable Pi

Use Cloudflare Workers Observability for request traces and operational errors. Use the application's Activity view and durable receipts to decide what actually happened. Telemetry is sampled diagnostic evidence; it cannot authorize, retry or reconcile work.

## Ownership and configuration

| Concern | Owner | Configuration |
| --- | --- | --- |
| Worker logs, native distributed traces and sampling | Alchemy → Cloudflare | `alchemy.run.ts`, all five production Workers |
| Effect spans | Alchemy's native Cloudflare tracer | `src/observability/worker.ts`, built within each invocation or job |
| Model usage, command results and recovery decisions | Existing domain records | Observers emit structured events after persistence |
| Issues and email notifications | Cloudflare Workers Issues | Native issue detection plus an account notification policy |
| Execution, permissions and cancellation | Existing domain services and Pi | Unchanged; never reconstructed from logs |

Logs and traces start at 100% sampling to establish a baseline for this personal application. This is a tunable operating decision, not a measured optimum. Revisit volume and billing before reducing sampling. Container stdout remains disabled; terminal receipts produce structured outcome events instead.

Alchemy 2.0.0-beta.81 supplies `Cloudflare.Telemetry()` and the native Effect tracer. Its automatic handler wiring applies to Alchemy-generated Worker and Durable Object handlers. Our Pi and Sandbox classes have existing native lifecycles. The package patch exposes the existing tracer subpath, without modifying its implementation. `runObserved` is the Promise bridge for these host callbacks; long-lived Durable Object runtimes do not retain invocation tracing context. No OpenTelemetry exporter, collector or flush loop is added.

Alchemy's native tracer forwards scalar attributes and `effect.exit` (`success`, `failure`, `interrupted`). Native Cloudflare trace IDs and Effect IDs differ. Use the Cloudflare trace association and durable run/operation IDs for correlation, not an assumed equality between their trace IDs. The short `Inference.dispatch` span identifies the model request. Its duration is dispatch instrumentation time, not model response time. Native provider-fetch spans may be siblings under the invocation. Durable inference records own response duration and usage.

The native hosts retain the short telemetry promise with `ctx.waitUntil`. This keeps work alive but does not extend the invocation trace. Model/tool attributes are annotated inside active Effect spans; the installed tracer does not forward attributes supplied only at span construction. A long task spans multiple invocations and therefore multiple traces. Native spans and logs remain diagnostic: in the first hosted smoke test, Activity held two completed model records, but the query returned only one inference log and a prematurely ended model span. The completion event now reads totals from the durable records, including request count, usage-reported count and known token totals. This does not make log delivery an accounting ledger. Incomplete records remain distinguishable from zero usage.

The installed Alchemy provider schema predates `observability.issues`. After each main deployment, `scripts/configure-observability.ts` resolves the five production Workers, reads their settings, changes only the observability section to enable Issues, then reads it back. Existing log/trace settings are retained; bindings are not included in the patch. Cloudflare resets Issues when subsequent deployments omit it, so this reconciliation stays in CI until Alchemy supports the field. The script uses the existing encrypted CI token and fails closed on ambiguous names or unexpected responses.

## Signals

| Event or span | What it establishes |
| --- | --- |
| `Website.agentRequest`, `Identity.ownerSession` | Authenticated website forwarding and session-lookup duration |
| Existing `Effect.fn` service spans | Time spent at instrumented application boundaries |
| `tool.waiting`, `tool.dispatched`, `tool.finished`, `tool.replayed` | Short lifecycle markers with bot, run and operation IDs; duration comes from the receipt journal |
| `Inference.dispatch` | Bot, run and attempt IDs; model, purpose and context budget at dispatch |
| `inference.finished` | Persisted request outcome, model, purpose, elapsed time, cached/uncached input and output usage |
| `conversation.finished` | Committed run completion, failure or cancellation, plus totals from the run's durable model records |
| `conversation.recovery` | A transition in the existing bounded-recovery policy |
| `terminal.finished` | A committed terminal outcome, exit code, checkpoint and network-policy status |
| `auth.session_lookup_failed` | A failed session lookup, returned as a fail-closed HTTP 503 |
| `harness.operation_failed`, `service.request_failed` | A handled operational failure, with its cause |
| `job:slow_dispatch`, `job:backlog_warning`, `alarm:memory_limit_reset` | Native Lifecycle attention signals; thresholds and recovery remain owned by Lifecycle |

Unknown provider usage remains `null`, not zero. Compaction and memory requests are distinguished by their existing inference purpose. Recovered terminal commands produce `interrupted` once and are not executed again by an observer. Error/Fatal Effect logs use native `console.error` so Cloudflare Issues can see handled failures. Routine cancellation and approval waits are not error events.

Session reads coalesce only while an identical request is pending. There is no session-response cache. Authentication mutations wait for existing reads and block new ones during cookie rotation. A 429's `Retry-After` applies to later reads without an automatic retry loop. Session reads have a separate initial limit of 120/minute; login, password and two-factor limits retain their existing protection.

## Investigate an incident

1. Open the affected Worker under **Workers & Pages → Observability** and choose the incident's time range.
2. Find its issue or filter structured logs by `annotations.event`. Narrow by `runId`, `turnId`, `attemptId` or `operationId` where present.
3. Open its native trace. Compare website/session time, service-binding calls, Durable Object RPC, storage calls and dispatch markers. Read complete model and tool-operation timings in Activity; detached work may span several invocations.
4. Check Activity and the durable execution receipt before considering another attempt. HTTP 200 means a response was served; it does not establish model or tool success. Missing logs do not establish that an action never happened.
5. For session lookup errors, inspect the logged cause and D1 spans. The initial incident showed a lookup failure; its underlying D1 cause was not established. Do not treat it as a confirmed D1 outage.
6. For stalled work, inspect native Lifecycle attention events and the current run state. Waiting for approval, external results or user input is legitimate; observability does not restart it.

The native **Durable Pi operational issues** notification policy uses the existing owner email destination. Five enabled issue automations notify after **three occurrences of the same issue**, not three errors per minute. This starting threshold is tunable. It suppresses single transient incidents but is not a rate-based availability SLO. Inspect and adjust the policy in Cloudflare; no application email scheduler is involved. Configuration/readback does not prove email delivery to the inbox.

## Browser errors

The workspace boundary, unhandled browser errors/rejections, and failed optional animation imports report to the authenticated, same-origin `POST /api/diagnostics/client-error` endpoint. The Website Worker writes an error-level `browser.error` event to existing Workers Logs. A recovery screen shows **Error reference** only after the endpoint acknowledges the report. Filter `annotations.event = browser.error` and `annotations.id` by that reference.

Reports contain the app's Git commit, page category, online status, fixed error signatures, React error codes, same-origin asset file/line/column locations, up to three nested causes and a React component trace when available. They exclude chat text, raw exception values, component names, account/agent IDs, cookies, headers, and URL queries/fragments. Unknown messages become `Unclassified browser exception`; use their source positions to find the failing expression. The endpoint validates every field and a 16 KiB body limit before logging. Only active family members can report. Duplicate error objects share one report and each browser sends at most five reports per minute.

For source locations, find the production deployment run whose commit matches `annotations.build`. Download its `client-sourcemaps-<commit>` GitHub Actions artifact within 90 days. The artifact contains source code from this public repository, not incident reports. Match `failure.frames[].file` (or `causes`/`components`) to the `.js.map` filename and resolve the recorded one-based browser line/column with a source-map tool (source-map columns are zero-based). This maps the exact deployed bundle to the original source. These browser reports use structured fields rather than a native server exception stack, so automatic Worker stack symbolication does not apply.

Logging is best effort: offline browsers, an expired session, a blocked request, or a failure before the workspace loads may produce no report. Logging failures never block **Try again** and do not claim a saved reference. A missing log is not proof that the page worked.

## Cancelled HTTP requests

Cloudflare's `canceled` outcome describes a cancelled invocation, often associated with a client disconnect. It is not equivalent to a cancelled agent run. The initial sample included 20 cancelled HTTP 200 reads lasting 67–158 ms, mostly workbench polling. A matched live objects request was `canceled` on Cloudflare but HTTP 200 with `Network.loadingFinished` in the browser. Polling is unchanged because this evidence does not establish lost responses or work. It does not explain all historical cancellations. Streaming connections also rotate normally and can close on navigation. Compare browser `Network.loadingFinished` or `loadingFailed` with the matching `cf-ray` and server trace before changing polling.

## Verification and limits

Run `pnpm verify` and `pnpm lint`. The suite covers independent invocation trace parents, nested spans, failure/interruption, usage fields, native error severity, Issues configuration preservation, session coordination/backoff, and terminal commit/restart observer behavior. Existing Pi loop-recovery scenarios also prove an observer failure cannot block the recovery decision. The native workerd check makes concurrent requests and verifies distinct parent spans without mocking the tracer.

Vite emits hidden server source maps; Alchemy's Worker bundler already generates maps. A successful build establishes map generation, not that a production exception was symbolicated. Hosted ingestion, native trace relationships, saved queries and notification configuration must be checked after deployment. Do not deliberately fail a personal task merely to test alert delivery.

Production verification on 12 October 2026: PR #63 deployed successfully. Readback confirmed logs, traces and Issues enabled for all five Workers. An inspected live trace joined `Website.agentRequest` → `Identity.ownerSession` → D1, and website forwarding → agent Worker → Durable Object/terminal calls. Browser session reads returned 200, 38 observed workbench/inference reads completed, and none of the observed API responses was an HTTP error. A synthetic bot used `date` once and answered correctly. Activity recorded two model requests (12,495 input tokens, including 6,016 cached, and 30 output tokens). The discrepancy between durable records and individual telemetry events prompted the invocation-lifetime/completion-total follow-up above.

Three saved account queries are available: **Durable Pi — request outcomes and latency**, **Durable Pi — model usage and outcomes**, and **Durable Pi — operational failures**. The notification policy and all five three-occurrence automations were read back enabled. Email receipt, production exception symbolication, live compaction and induced production restart/failure remain untested; those lifecycle/error cases have local coverage.

References: [Alchemy telemetry source](https://github.com/alchemy-run/alchemy/blob/main/alchemy/src/Cloudflare/Workers/Telemetry.ts), [Cloudflare traces](https://developers.cloudflare.com/workers/observability/traces/), [custom spans](https://developers.cloudflare.com/workers/observability/traces/custom-spans/), [Issues](https://developers.cloudflare.com/workers/observability/issues/), [issue automations](https://developers.cloudflare.com/workers/observability/issues/automations/), [errors and outcomes](https://developers.cloudflare.com/workers/observability/errors/), [source maps](https://developers.cloudflare.com/workers/observability/source-maps/).

## Durable run timeline

Open **Activity**, select a conversation or tool event, then inspect **Run timeline**. The timeline is a read-only projection of the owning bot's SQLite records, with stable 50-record pages. Model totals include every attempt in the run, including compaction and requests beyond the old latest-100 Activity limit. Cached input is included in input, not additional to it; missing usage remains explicit.

The run ID is the accepted root conversation turn. Steering belongs to that same run. The Pi session and model-attempt/tool-operation identifiers provide narrower correlation; none is a native Cloudflare trace ID. Plans can span several runs and retain their own task identity. Independent background groups retain their separate lifecycle and Activity detail; their model logs carry the originating run and parent bot IDs, but their usage is not silently added to the foreground run's SQLite totals.

Conversation owns start/stop/finish times. Access owns its receipt transition history, written atomically by SQLite triggers and indexed by operation. Reading or replaying a status does not append another transition. The history contains status, timestamp and revision only; permission checks still use the original receipt and policy. Recovery records view changes in its existing transaction. These records never drive scheduling.

Elapsed run time includes waiting. Each receipt separates approval waiting, ready-to-dispatch time, and dispatch-to-saved-result time. The latter can include recovery downtime and is not CPU time. An interrupted model's finish timestamp records when interruption was detected, so its actual duration is shown as unknown. Existing records without timing are not backfilled with guesses. A dispatched tool without a terminal receipt after the run ends is shown as unconfirmed, not completed.

Expand **Cloudflare correlation**, copy the run ID and open the linked Cloudflare traces page. In Workers logs, filter `annotations.runId` by that ID; tool/model/recovery/completion events also include `annotations.botId`. Open each event's associated native trace. The link opens the dashboard, not a fabricated single trace or undocumented pre-filter. Existing pre-deployment logs may only have `turnId`, `attemptId` or `operationId`.

Native workerd verification kills the runtime after three committed tool failures, reopens the same SQLite database, and compares the full run projection and receipt transitions. A second restart after the blocker proves neither the timeline nor recovery reading dispatches more work. Node coverage also verifies more than 100 attempts, bot/run isolation, approval denial and rollback, compaction purpose, steering, cancellation, unknown historical timings and interrupted provider requests. Browser checks cover mobile layout, correlation controls and pagination. Hosted evidence is recorded in the delivery PR.
