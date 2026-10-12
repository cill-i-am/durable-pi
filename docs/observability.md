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

Alchemy's native tracer forwards scalar attributes and `effect.exit` (`success`, `failure`, `interrupted`). Native Cloudflare trace IDs and Effect IDs differ. Use the Cloudflare trace association and durable run/operation IDs for correlation, not an assumed equality between their trace IDs. A model duration span joins Pi's existing response stream; it does not send a second request. Native provider-fetch spans may be siblings under the invocation.

The native hosts retain that telemetry promise with `ctx.waitUntil`. Model/tool attributes are annotated inside the active Effect span; the installed tracer does not forward attributes supplied only at span construction. A long task spans multiple invocations and therefore multiple traces. Native spans and logs remain diagnostic: in the first hosted smoke test, Activity held two completed model records, but the query returned only one inference log and a prematurely ended model span. The completion event now reads totals from the durable records, including request count, usage-reported count and known token totals. This does not make log delivery an accounting ledger. Incomplete records remain distinguishable from zero usage.

The installed Alchemy provider schema predates `observability.issues`. After each main deployment, `scripts/configure-observability.ts` resolves the five production Workers, reads their settings, changes only the observability section to enable Issues, then reads it back. Existing log/trace settings are retained; bindings are not included in the patch. Cloudflare resets Issues when subsequent deployments omit it, so this reconciliation stays in CI until Alchemy supports the field. The script uses the existing encrypted CI token and fails closed on ambiguous names or unexpected responses.

## Signals

| Event or span | What it establishes |
| --- | --- |
| `Website.agentRequest`, `Identity.ownerSession` | Authenticated website forwarding and session-lookup duration |
| Existing `Effect.fn` service spans | Time spent at instrumented application boundaries |
| `Access.tool` | Tool identity, run and operation IDs; dispatch versus replay |
| `Inference.request` | Model, purpose, context budget, outcome and request duration |
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
3. Open its native trace. Compare website/session time, service-binding calls, Durable Object RPC, storage calls, model duration and tool spans.
4. Check Activity and the durable execution receipt before considering another attempt. HTTP 200 means a response was served; it does not establish model or tool success. Missing logs do not establish that an action never happened.
5. For session lookup errors, inspect the logged cause and D1 spans. The initial incident showed a lookup failure; its underlying D1 cause was not established. Do not treat it as a confirmed D1 outage.
6. For stalled work, inspect native Lifecycle attention events and the current run state. Waiting for approval, external results or user input is legitimate; observability does not restart it.

The native **Durable Pi operational issues** notification policy uses the existing owner email destination. Five enabled issue automations notify after **three occurrences of the same issue**, not three errors per minute. This starting threshold is tunable. It suppresses single transient incidents but is not a rate-based availability SLO. Inspect and adjust the policy in Cloudflare; no application email scheduler is involved. Configuration/readback does not prove email delivery to the inbox.

## Cancelled HTTP requests

Cloudflare's `canceled` outcome describes a cancelled invocation, often associated with a client disconnect. It is not equivalent to a cancelled agent run. The initial sample included 20 cancelled HTTP 200 reads lasting 67–158 ms, mostly workbench polling. A matched live objects request was `canceled` on Cloudflare but HTTP 200 with `Network.loadingFinished` in the browser. Polling is unchanged because this evidence does not establish lost responses or work. It does not explain all historical cancellations. Streaming connections also rotate normally and can close on navigation. Compare browser `Network.loadingFinished` or `loadingFailed` with the matching `cf-ray` and server trace before changing polling.

## Verification and limits

Run `pnpm verify` and `pnpm lint`. The suite covers independent invocation trace parents, nested spans, failure/interruption, usage fields, native error severity, Issues configuration preservation, session coordination/backoff, and terminal commit/restart observer behavior. Existing Pi loop-recovery scenarios also prove an observer failure cannot block the recovery decision. The native workerd check makes concurrent requests and verifies distinct parent spans without mocking the tracer.

Vite emits hidden server source maps; Alchemy's Worker bundler already generates maps. A successful build establishes map generation, not that a production exception was symbolicated. Hosted ingestion, native trace relationships, saved queries and notification configuration must be checked after deployment. Do not deliberately fail a personal task merely to test alert delivery.

Production verification on 12 October 2026: PR #63 deployed successfully. Readback confirmed logs, traces and Issues enabled for all five Workers. An inspected live trace joined `Website.agentRequest` → `Identity.ownerSession` → D1, and website forwarding → agent Worker → Durable Object/terminal calls. Browser session reads returned 200, 38 observed workbench/inference reads completed, and none of the observed API responses was an HTTP error. A synthetic bot used `date` once and answered correctly. Activity recorded two model requests (12,495 input tokens, including 6,016 cached, and 30 output tokens). The discrepancy between durable records and individual telemetry events prompted the invocation-lifetime/completion-total follow-up above.

Three saved account queries are available: **Durable Pi — request outcomes and latency**, **Durable Pi — model usage and outcomes**, and **Durable Pi — operational failures**. The notification policy and all five three-occurrence automations were read back enabled. Email receipt, production exception symbolication, live compaction and induced production restart/failure remain untested; those lifecycle/error cases have local coverage.

References: [Alchemy telemetry source](https://github.com/alchemy-run/alchemy/blob/main/alchemy/src/Cloudflare/Workers/Telemetry.ts), [Cloudflare traces](https://developers.cloudflare.com/workers/observability/traces/), [custom spans](https://developers.cloudflare.com/workers/observability/traces/custom-spans/), [Issues](https://developers.cloudflare.com/workers/observability/issues/), [issue automations](https://developers.cloudflare.com/workers/observability/issues/automations/), [errors and outcomes](https://developers.cloudflare.com/workers/observability/errors/), [source maps](https://developers.cloudflare.com/workers/observability/source-maps/).
