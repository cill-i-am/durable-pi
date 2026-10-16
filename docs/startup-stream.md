# Startup stream compression

16 October 2026. This increment follows the [startup investigation](production-startup.md) and unified loading shell. It targets transport bytes at the website adapter, preserving the conversation protocol and its durable owner.

## Baseline and result

The first ten-load production cohort, at 390 × 844 with 4× CPU slowdown, 150-ms latency and disabled browser cache, has a 7,812.5-ms committed-history median (7,339.8–8,667.7 ms). The initial stream delivers 167,698 decoded bytes without compression. Session readiness has a 4,316.4-ms median. These are Chrome-controller observations, not an independent field-performance estimate. A later trace returned stale navigation marks and was discarded. Do not compare this cohort to a different viewport or browser connection.

Recovery of the production browser reset its emulation. A separately labelled ten-load desktop baseline at 1272 × 902, normal CPU/network speed and browser-managed reload cache has a **954.4-ms** history median (861.4–1,438.2 ms). All ten documents are distinct and visible, with twenty response controls, an enabled composer and no horizontal overflow. Its deployed website version is `458ac0d2-9479-46ec-88cb-8f52a39d8831`. Post-deployment results belong on the PR using this same desktop protocol; they must not be compared against the constrained mobile cohort. Neither warm-server cohort estimates the first Durable Object wake.

The controlled fixture uses the fully styled workspace and the same synthetic twenty-response activity history, build, server, browser and delays on both sides. Only encoding changes. One warmup per condition is separate; ten AB/BA pairs use the constrained mobile profile. No builds or profiling run during this cohort.

| Measure                                              |           Identity |               Gzip |
| ---------------------------------------------------- | -----------------: | -----------------: |
| Median committed-history readiness                   |         4,319.8 ms |         3,698.1 ms |
| History range                                        | 4,284.0–4,350.8 ms | 3,665.5–3,722.0 ms |
| Median initial body transfer interval                |           960.0 ms |             6.2 ms |
| Initial stream bytes, excluding HTTP headers/framing |            190,948 |              3,009 |
| Decoded bytes                                        |            190,948 |            190,948 |
| Median browser script time                           |           365.9 ms |           467.2 ms |

Readiness improves **621.7 ms (14.4%)** in this fixture. Script time rises by 101.3 ms; the net improvement includes that cost. The fixture is highly compressible and does not predict the production compression ratio or latency gain. Every run retains twenty responses and the composer without overflow. [Numeric samples and exclusions](startup-stream-measurements.json) retain no conversation content, credentials, headers or query strings.

Two frontend experiments were reverted: splitting the authentication shell made the matched fixture slower, and removing a barrel export did not reduce initial JavaScript. Neither result is included as a shipped improvement.

Cloudflare's pre-change one-hour diagnostic has twelve `Website.agentRequest` spans with a 923-ms median and 2,799-ms p95, twelve `Identity.ownerSession` spans at 40/191 ms and twenty-five `Conversations.snapshot` spans at 21/37 ms. These small, audit-influenced inclusive spans overlap and cannot be summed. Stream lifespan is not startup latency. They support testing transport next; they do not establish that the server has no remaining startup cost.

## Implementation and architecture review

The website negotiates gzip for successful GET event streams, retains private/no-store headers, varies by Accept-Encoding and removes the identity Content-Length. It honors Cloudflare's original visitor encoding value when available. Ordinary responses, upgrades and existing encodings retain their existing behavior.

The native gzip codec flushes each incoming chunk with `Z_SYNC_FLUSH`; whole-response compression buffered tiny events in a native prototype and was rejected. [`encodeBody: "manual"`](https://developers.cloudflare.com/workers/runtime-apis/response/) tells Workers that the body is already encoded. A native Response-copy test verifies the framework does not encode it twice. [Workers' Node zlib support](https://developers.cloudflare.com/workers/runtime-apis/nodejs/zlib/) supplies the codec without a new dependency.

**Effect 4.0.1 / Tardigrade / OpenCode review:** the named Effect operation lives in the website transport adapter. Core services and their Streams, schemas, durable journal and authorization remain in their existing owners. No runtime is added and no service executes an Effect internally. Native callback promises are confined to the HTTP body boundary. Its pipe preserves backpressure, observes rejection, and cancellation joins upstream cleanup before resolving. This small Node/DOM byte bridge avoids unsafe casts between incompatible BYOB stream interfaces. The pinned Effect Stream/NodeStream APIs were tried first; the native byte boundary has direct conformance tests for pre-read cancellation and failed handoff. There is no new application concurrency framework.

**Executor / Effect error review:** private bodies are never cached. Admission and fresh owner checks run before forwarding as before. Proxy cleanup retains both upstream and outgoing responses until handoff, attempts every release and preserves compound failures. No `instanceof` error routing or generic success fallback is introduced. Source failures fail the encoded body reader. Once HTTP headers have been sent, workerd can close the HTTP connection as an EOF; the native failure test therefore asserts the body reader directly rather than promising a browser transport error that the platform cannot guarantee.

**Alchemy / host lifetime review:** resource IDs, stages, bindings, package pins, storage transactions and Pi lifecycle ownership are preserved. Only the Website opts into [`enable_request_signal`](https://developers.cloudflare.com/changelog/post/2025-05-22-handle-request-cancellation/). A real socket disconnect otherwise failed to cancel the JavaScript source in the pinned workerd runtime. The adapter directly closes the codec on the host signal; tests verify that this cancels upstream once and removes its listener when the pipe settles.

## Validation and next step

TypeScript, **1,562 tests in 155 files**, all **18 native workerd gates**, website and four Worker builds pass. The focused transport/proxy set has 38 tests, covering negotiation, identity fallback, preserved headers, first event and later heartbeat before EOF, late source failure, cancellation before the first event, held cleanup acknowledgment, failed cleanup, already-aborted requests and failed host registration. The native gate also checks real TCP disconnect and Response copying. Lint has no errors and the existing test shadow warning. Hosted CI remains the merge gate.

After deployment, verify the live stream's encoding and unchanged decoded snapshot, repeat the desktop cohort, and record the deployed Worker version on the PR. The remaining constrained startup budget is dominated by initial application loading and browser work before authentication begins; a future increment needs a valid production CPU profile before choosing further splitting or rendering changes.
