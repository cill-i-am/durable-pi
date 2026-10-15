# Workspace performance hillclimb

Baseline: `6b0f49182e6216fe709d58e187b8ce4eecb3ea42`, production audit on 15 October 2026. The audit's post-deployment telemetry window was 08:39–15:50 UTC, before audit traffic. Small samples do not establish production p95 or field Core Web Vitals.

## Measurements

| Experiment                                       | Before           | After           | Evidence and limits                                                                                                                                         |
| ------------------------------------------------ | ---------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial chat JavaScript, local gzip              | 569,877 bytes    | 468,147 bytes   | 17.9% reduction in Start's matched-route preload graph; default local gzip, not Cloudflare transfer bytes.                                                  |
| Desktop history visible                          | 912.6 ms median  | 777.8 ms median | Ten synthetic browser runs per condition, 871 × 853.                                                                                                        |
| Mobile-width history visible                     | 918.5 ms median  | 781.4 ms median | Ten synthetic browser runs per condition, 390 × 844; desktop Chromium without CPU/network throttling.                                                       |
| Idle finite requests in one minute               | 23               | 4               | Empty chat: checklist 15 → 0, statuses 6 → 2, session 2 → 2. Stream traffic excluded.                                                                       |
| New credential version during obsolete discovery | 101.35 ms median | 0.08 ms median  | Ten controlled runs: the old provider lookup is deliberately held for 100 ms. Measures removal of queueing, not provider discovery speed.                   |
| Unchanged conversation reconnect                 | 168,317 bytes    | 99 bytes        | Synthetic twenty-turn transcript, application SSE frames, excluding headers and later heartbeats. Changed/unknown/restarted state receives a full snapshot. |

The initial split achieved only 5.4%; moving the highlighter behind its first actual use and separating shared upload controls improved it. Initial-JS reduction and history readiness remain below the proposed 30%/25% goals. The changes are retained for repeatable smaller gains; those goals are not reported as achieved.

The browser fixture uses the real workspace with a small route shell and loopback-only synthetic API. It fixes session/catalog/stream delays at 150/500/100 ms, uses the same twenty-turn transcript, and denies every API mutation. It does not measure website SSR, Cloudflare placement, actual OAuth, model generation, or physical-phone input. The intermediate stage-one fixture retained serial conversation loading; its median history readiness was 886.8/895.2 ms at desktop/mobile widths. Final samples and bundle details are in [performance-measurements.json](performance-measurements.json).

## Stage reviews

### 0. Repeatable evidence

Added a route-preload measurement command, a synthetic browser fixture, and bounded local `pi:*:ready` User Timing marks for the initial session, catalog, conversation and model data, plus committed history and usable composer UI. Marks contain no identities or content and are not transmitted. Browser history/composer visibility in the fixture is measured separately after DOM mutations.

**Effect/Alchemy review:** reuse existing request/operation spans and the retained host runtime. No exporter, global tracing change, credential access or infrastructure resource is added. Field INP and signed-in field LCP remain unmeasured.

### 1. Optional frontend code

The installed TanStack Start plugin already applies automatic route splitting. Optional panels and settings share the workspace route, so they now use local lazy component boundaries. Upload controls have a small shared module; unopened file-preview/workbench code is separate. Syntax highlighting retains its plain-text rendering while its existing engine loads on demand.

**Review:** follows [TanStack's critical versus noncritical route guidance](https://tanstack.com/router/latest/docs/guide/code-splitting#using-automatic-code-splitting); no second router plugin is installed. Existing UI primitives, route/search contracts, navigation guards, attachment operations and native cancellation are retained. The mobile checklist panel loads, has no horizontal overflow, and returns focus to its trigger after closing.

### 2. Conversation startup

After authentication, a directly addressed agent's conversation subscription starts alongside the agent catalog. Rendering still waits for the authorized profile. Root navigation waits for selection before subscribing; collection pages hold no conversation stream. The installed TanStack client creates a new client per thread identity and suppresses callbacks from inactive clients.

**Effect/reference review:** HTTP and the native gateway still perform fresh server authorization. This changes scheduling in the browser, not aggregate admission or authority. No private SSR cache or optimistic authorization is introduced. This follows the narrow-capability and host-edge separation recorded in the [reference architecture review](effect-native-refactor.md#evidence-and-review-basis).

### 3. Idle work

Checklist refresh demand belongs to its visible consumers or retained pending saves. Visible checklists and pending recovery retain the four-second cadence; unused empty chat does not poll. Unchanged list revisions preserve the external-store snapshot. Agent statuses wait for catalog membership before their initial request, avoiding the abandoned startup request.

**Trade-off:** background agent-status fallback changes from ten to thirty seconds; foreground visibility triggers a fresh read. The selected agent still receives live conversation status. Session checking and server revocation enforcement are unchanged.

**Review:** pending receipts stay in their existing store and native journal; no optimistic receipt settlement is added. Browser validation confirmed a retained pending save refreshes even without an open panel, while the empty chat issues no checklist requests. Existing lost-response/restart/conflict tests continue to pass.

### 4. Catalog concurrency

Replaced the instance-wide lookup permit and manual timestamp cache with Effect 4.0.1 `Cache.makeWith`, capacity one, keyed by the opaque credential version. Successful lookups retain the existing sixty-second TTL; failed/degraded results have zero TTL. Authority is checked before cache access and before publishing a loaded result. Remote grants remain uncached locally.

**Effect/skill review:** native keyed single flight removes cross-version queueing, preserves invocation services/Clock, and interrupts abandoned lookups through the existing adapter cleanup. TTL, account change, concurrent waiter cancellation, defects, and remote forwarding tests pass. No extra provider retry or detached refresh fiber is introduced. The cold OAuth/discovery latency observed in production remains external work; this change does not claim to remove it.

### 5. Reconnect payload

The native agent retains one volatile serialized checkpoint and an opaque Schema-branded cursor. The client acknowledges it only after preceding frames. A reconnect with the same current state retains the transcript; a changed state, invalid cursor, new view, explicit reload or actor restart receives a complete snapshot. The sixty-second stream lifetime and fresh authorization remain.

**Effect/Tardigrade/Alchemy review:** the existing scoped event pump, watcher cleanup, backpressure and native Pi journal remain authoritative. This checkpoint is a bounded adapter optimisation with a full-resync fallback, not a second persistence system. Tests cover successful resume, changed/restarted/unknown state, fresh 401 rejection and fresh transports. Existing stream cleanup and native host checks pass.

**Rejected for this increment:** removing heartbeat reconciliation without an authoritative cheap revision source could hide missed notifications or session changes. Its fifteen-second refresh remains. The measured win is transfer size, not elimination of snapshot CPU work.

### 6. Maintenance and remaining cost

Reviewed the slow background spans against the existing maintenance code. Backup already skips unchanged watermarks and compaction only wakes backup when the watermark changes. The audit did not establish that background summary/backup durations cause foreground contention. No backup cadence, compaction policy, instrumentation sampling, SQLite storage or authority projection is changed.

Further changes require traces showing a foreground wait or a repeatable cost reduction. Inclusive nested span durations must not be added together, and a sixty-second SSE lifetime is not response readiness.

## Validation and reproduction

- TypeScript, lint (one existing test shadow warning), all 1,534 tests in 153 files, website and four Worker builds.
- Native workerd gates: SQLite transaction laws, restart/lost acknowledgment, session revocation, Pi/tool interruption, delegation, and ordered cleanup of held provider/credential/SSE/export work.
- Sixty synthetic browser loads across baseline, intermediate and candidate, ten runs per width/condition; synthetic pending-save and panel-focus checks.

Build and measure production preload bytes with `pnpm build` followed by `node scripts/measure-client.mjs`. Run the synthetic workspace with `node scripts/performance/server.mjs 4397`. Run the same fixture at another port against a baseline checkout using the same lockfile. Compare cold/warm conditions separately and retain distributions, not a single score.

For the next iteration, use the production User Timing entries alongside Resource Timing and Cloudflare traces, distinguish first data from first painted content, and measure real interactions before claiming an INP improvement. Continue toward the initial goals only with repeatable evidence and unchanged authorization/recovery guarantees.
