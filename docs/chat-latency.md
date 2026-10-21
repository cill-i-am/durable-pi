# Send and inference latency

The October 19 production trace for a 1.40-second Send acceptance contained 988 ms in `Inference.discoverCatalog` and 1,110 ms in `Inference.readModelCatalog`. The complete admission operation took 1,130 ms. Its provider model-list fetch alone took 956 ms. This is a real production trace, not a simulated provider. Trace: `27e3de3ad1e1f93f3384f33616447a52`, starting `2026-10-19T22:05:39.546Z`, revision `7a2389d`.

## October 19 baseline changes (PR #174)

- Successful model capability metadata lasts five minutes instead of one. Live family membership and current credential identity are still checked on every read. Reconnection changes the cache key; failures are not cached and expired success is never a fallback. Remote readers still forward to the owner on every read. The tradeoff is up to five minutes of capability metadata age; this does not cache authorization. The first read after expiry still discovers models.
- Each existing family authority boundary reads the model owner and member in one joined SQL snapshot instead of two sequential D1 requests. No boundary or credential check is removed. Sixty native SQLite parity comparisons cover roles, verification, outsider isolation, owner changes, removal and reinvitation.
- The event pump publishes the leading change immediately, then coalesces the next 80 ms of changes. Previously it waited 80 ms before the leading change. The sliding queue, reader limits, authorization and cleanup remain in place.

## Measurement contract

`GET /api/agent/inference` includes optional `timings` on new settled attempts:

| Field | Offset from native stream admission |
| --- | --- |
| `fetchStartMs` | Provider transport invoked; local preflight has completed |
| `responseHeadersMs` | Provider fetch returns response headers |
| `firstEventMs` | First parsed provider event |
| `firstTextMs` | First nonempty `response.output_text.delta` |

Offsets use the same worker clock. Subtract `fetchStartMs` from `firstTextMs` for provider transport-to-first-text, including network and provider processing. An absent field means the milestone was not observed, not zero latency. Tool-only responses have no text milestone. These are numeric counters only: no response headers, tokens, prompts or text are stored. They are written with terminal usage, not on each token. Old and interrupted records may have no timings.

The existing attempt duration includes local preflight and final settlement; it is not provider time to first token. Browser Send-to-first-visible-text uses a separate monotonic clock and DOM observer. Do not subtract browser and worker wall clocks as if they were synchronized. Send acceptance uses the browser's request-to-response-headers resource timing. Compare the same agent, model, reasoning setting and prompt shape; report cold and warm catalog conditions and input/cache-token counts. Small live samples describe the observed runs, not a population percentile or guaranteed speedup.

The regression tests first reproduced repeated catalog discovery at 90 seconds and the mandatory 80 ms leading-stream delay, then passed with the fixes. Native provider tests verify that phase milestones survive the existing usage ledger without retaining prompt or credential contents.

## Account catalog reuse and refresh-ahead

This supersedes the hard five-minute expiry above.

The follow-up cache uses the account's persisted connection generation and the installed adapter capabilities as its identity. Token rotation retains that generation; reconnecting or replacing a deployment seed creates another. Legacy credentials acquire a generation lazily in the existing SQLite transaction. No new credential table or migration is needed.

Successful catalog snapshots are persisted in the account Durable Object. They are fresh for five minutes and reusable for up to one hour from the last successful verification. A stale read starts one scoped Effect refresh and immediately returns the snapshot. The host retains that work; disconnecting a reader does not cancel it. Restarts restore the same bounded snapshot. Transient failures retain success with exponential retry spacing capped at one minute; a hard-expired result is never served. Confirmed denial, invalid metadata, or an unclassified error replaces success with an unavailable result. Failure to persist a result blocks further reads in that runtime. Reconnect races cannot publish an old generation. Members still resolve the current owner and live membership on every read, with no independent cache on the member agent.

Catalog identity inspection does not resolve a token over the network. It can start account-owned refresh-ahead. Credential `expires` remains the usable-until time, already reduced by three minutes for safety; refresh-ahead starts five minutes before that. An otherwise valid token remains usable during an owned refresh. At usable-until it must join refresh before use. Failed or orphaned rotation intent blocks both metadata and credential reuse until reconnect; there is no refresh-token replay after an uncertain outcome. The existing owner serialization, persisted rotation intent, conditional commit and shutdown settlement remain in place.

The client model query uses `@tiesen/effect-tanstack-query` with TanStack Query and the Effect HTTP client. Its cache is scoped to the authenticated family workspace, keyed by agent, and cleared when that workspace unmounts. Mounted consumers share a request and refresh once a minute while active, which also provides an opportunity for OAuth refresh-ahead before Send. Settings changes cancel pending reads before mutation and invalidate after it; older responses cannot roll back a newer settings revision. Transport failures hide cached availability. The client cache never authorizes Send.

Neither background work nor cache warming guarantees a warm account after a long idle period. A missing or hard-expired catalog still requires discovery, and an expired token still requires refresh before inference. Acceptance and first-text timing must be measured separately; provider processing is unaffected by these changes.

## First text delivery

An October 20 production probe observed a 250,075-byte `MESSAGES_SNAPSHOT` for a nine-token response. Existing text growth used deltas, but adding the first assistant text message retransmitted the complete visible history.

When exactly one assistant text message is appended and every preceding message is unchanged, the adapter now emits TanStack's native `TEXT_MESSAGE_START` with the durable metadata and `TEXT_MESSAGE_CONTENT`. Subsequent text uses the existing delta path. Metadata changes, replacements, tools, deletions and reconnects still use authoritative snapshots. The existing scoped Effect stream owns publication, backpressure and cancellation.

Disabling SSE compression was tested in production in PR #183 but did not establish a latency improvement: five-chat median Send-to-visible-text was 4,893 ms before and 6,090 ms after, with variable provider time and one slow admission. Compression is restored; reducing first-text payload size is measured separately. These small sequential samples do not establish a percentile or a causal regression.

### Correlated first-text handoffs

The actor retains at most 32 volatile first-text records, containing IDs and clock readings only. The provider callback records `providerAt`; the native committed-event watcher records `nativeObservedAt`. The snapshot that first publishes an answer records `snapshotStartedAt`, `snapshotReadyAt` and `publishedAt`. Its TanStack batch includes a `durable-pi.first-text` custom marker, in the same queue slot as its first regular frame. Historical reconnect snapshots do not claim to be a fresh first-text delivery.

The gzip website adapter observes that bounded marker without changing bytes. `Conversation.firstTextProxy` logs its `turnId`, `attemptId`, `publishedAt`, `proxyReceivedAt` and the first subsequent codec output read, `proxyOutputAt`. The latter is an output handoff bound, not proof that a particular compressed byte corresponds to a text token. It is available only on gzip responses. Oversized or malformed lines are ignored; conversation content is never logged. The browser measurement records marker receipt, first text receipt and first DOM appearance on its own monotonic clock.

Subtract actor milestones from each other, and proxy milestones from each other. Cross-machine wall-clock differences are diagnostic estimates, not precise one-way network measurements. Workers clocks advance on I/O; zero intervals do not prove zero CPU work. Missing native milestones remain missing rather than being inferred from publication. Diagnostics do not authorize, persist, retry or alter any model request.

A live CPU profile on the deployed revision identified a 263ms first-text render commit: unchanged timestamp formatting accounted for about 51ms of sampled CPU, and historical Markdown parsing also ran again. The shared Markdown component now memoizes its text prop; each delivery timestamp memoizes its unchanged date. Changed text and timestamps still render normally, and child state (including syntax highlighting) keeps its normal React lifecycle.

For an authenticated investigation, `events?protocol=tanstack&diagnostics=storage` adds `storageSyncStartedAt` and `storageSyncReadyAt` to first-text markers. This opt-in Effect joins `ctx.storage.sync()` after the first answer snapshot and before publication, so its duration measures outstanding write confirmation on the actor's clock. Ordinary streams do not add this wait. It does not change write confirmation policy, skip output gates, or expose a control in the UI. Use paired ordinary and diagnostic streams to distinguish storage confirmation from the remaining actor-to-proxy interval; cross-host clock differences still apply to that latter interval.

Paired production probes on October 21 returned immediately from `storage.sync()` while the marker still took roughly 0.47–1.49 seconds to reach the browser. This excludes pending writes at that checkpoint in those samples; it does not exclude writes begun afterward. The same opt-in diagnostic stream now logs `Conversation.firstTextGateway` at the intermediate Worker, with `gatewayReceivedAt`, `publishedAt`, `turnId` and `attemptId`. Join on both turn ID and publication timestamp because multiple clients can observe one turn. The observer adds a bounded stream reader only for diagnostic requests, forwards bytes unchanged, and joins upstream cancellation. Ordinary responses retain direct native forwarding. This separates the Durable Object-to-gateway interval from gateway-to-website receipt, subject to cross-host clock differences and the probe's additional reader.
