# Production startup

The next increment is documented in [startup stream compression](startup-stream.md), with a fresh production baseline, matched before/after measurements and the Effect/Alchemy review.

**16 October fixture correction:** [The unified-startup investigation](unified-startup.md#fixture-correction) found incomplete utility CSS in the local fixture and corrected its source scanning. The historical synthetic timing numbers below are diagnostic records of that older fixture, not measurements of the fully styled application. Production browser cohorts are separate and unaffected.

Baseline: main `5df056f814564e5b4f97d5c3629addd0eb2652ea`, 15 October 2026. The original 5.7–17.3-second range mixed isolated observations; it is not a reliable before/after distribution.

## Measurement protocol

Ten signed-in production reloads use one explicit 390 × 844 viewport, 4× CPU slowdown, 150-ms network latency, 200,000-byte/s download, 93,750-byte/s upload and disabled browser cache. This is a warm-server cohort; the initial navigation that wakes the actor is separate. Document visibility is recorded. No local builds or CPU sampling run during the measured cohort. Readiness uses the existing committed-history mark, and CDP Network data separates headers, first body bytes and the initial payload's last bytes. No conversation bodies, credentials or tool inputs/results are retained.

The new baseline has a 5.92-second median and a 5.59–6.24-second range. Session readiness is around four seconds; the initial 168-KB stream takes roughly 0.8 seconds to transfer, followed by roughly 0.6 seconds of client processing/rendering. The historical 17.3-second result did not recur. A separate sampled diagnostic maps the main layout hotspot to Base UI's collapsible panel animation/layout measurement. This identifies work to test; it does not prove the cause of the historical outlier.

The initial actor wake has a separate server tail: a catalog request spent 3,373 ms in the Durable Object subrequest while the inner catalog handler took 13 ms. The parallel conversation profile RPC waited 3,359 ms before its inner handler began, then terminal synchronization took 450 ms. The installed Agents 0.27.0 Lifecycle starts capabilities in order under `blockConcurrencyWhile`, including native Pi restoration. This shared startup gate is a source of cold-versus-warm variation; the trace does not distinguish all platform, construction and capability-start costs inside that wait. It must not be bypassed or replaced with a second journal. Post-deployment first-wake observations must be reported separately from the warm cohort.

The controlled activity fixture reproduces the hidden-panel behavior missing from the original text-only fixture. It runs the real workspace with synthetic read-only APIs. Before/after order alternates; each condition has ten runs under the same browser constraints. Every recorded run verifies its origin. An initial helper-binding mistake was detected and its four probes were discarded. Raw numeric samples and exclusions are in [production-startup-measurements.json](production-startup-measurements.json).

## Increment 1: mount activity details when opened

Production mounted 49 closed activity panels containing 56 hidden code blocks. Removing `keepMounted` uses [Base UI's normal panel lifecycle](https://base-ui.com/react/components/collapsible), deferring closed reasoning and tool details. Open, running and attention states retain the existing presentation and controls.

The activity fixture's median committed-history time changes from 4,765.9 to 4,520.8 ms, about 5.1% earlier. Median script time falls from 674.0 to 429.7 ms. Mounted elements fall from 2,905 to 985 while all twenty responses remain. Group opening, nested tool details, copy-control availability, keyboard collapse/focus and horizontal overflow were checked. Nested disclosure state is ephemeral and can reset when its parent unmounts; durable tool results and receipts remain in their owners.

**Effect/reference review:** this is a view lifecycle change. It adds no backend runtime, cache, detached work or authority bypass. Existing Schema decoding, journals, server admission and scoped streams are unchanged. It follows the reference architecture's separation of interpreted presentation from durable execution and the TanStack skill's guidance to avoid unused rendering work. The activity-presentation tests pass.

## Increment 2: reuse successful terminal acknowledgments

Terminal configuration performed a remote authority projection even on repeated identical reads. During the baseline audit, `Agents.synchronizeTerminalAuthority` has a 46-ms median and 515-ms maximum across 53 spans. Fresh identity has a 24-ms median and 95-ms maximum across 115 spans. These samples are audit-influenced; nested spans overlap and must not be summed.

An actor-owned Layer now retains one successful acknowledgment for sixty seconds, keyed structurally by revision, active state and sticky revocation fence. Changed keys proceed independently of an older held lookup. Failure has zero TTL. Restart builds a fresh cache. The gateway still fetches the authoritative profile and checks owner/session admission on each request; configuration still re-reads admission after synchronization before waking work. Terminal-side monotonic authority remains authoritative.

A controlled ten-run benchmark performs ten identical projections with a synthetic 25-ms acknowledgment. It measures 260.33 → 26.31 ms median per group and ten → one transport calls. This demonstrates removal of repeat work; it is not a production latency estimate. Run it with `pnpm exec tsx scripts/performance/measure-authority.ts`.

**Effect/Alchemy review:** Effect 4.0.1 `Cache.makeWith` provides bounded keyed single flight and invocation Clock/services. The existing managed actor runtime owns the Layer; no new runtime or promise map is introduced. The cache stores successful delivery acknowledgments, not permission to execute. Typed errors, native response cleanup and the enclosing uninterruptible projection acknowledgment are retained. Tests cover expiry, failed acknowledgment retry, structural-key reuse, concurrent callers, newer revocation passing a held old projection, late archive fences, actor isolation and restart. The existing configuration/RPC tests also pass. Local stream-header, decoded-snapshot and metadata timing marks add bounded labels without transmitting identities or payloads.

## Increment 3: load activity decorations when used

The idle composer eagerly imported `border-beam`, and completed-history code eagerly imported `thinking-orbs`. They now load through explicit lazy boundaries. The composer's input stays in a stable native container; its animated border is an aria-hidden, pointer-transparent sibling. Activity changes cannot remount or cover the input. The border decoration unmounts immediately when activity stops instead of running its previous decorative fade-out.

The matched route's initial JavaScript changes from 468,181 to 445,436 bytes with local gzip, a further 4.9% reduction. In ten alternating constrained runs per condition, committed-history median changes from 4,544.2 to 4,388.8 ms, about 3.4% earlier; median script time changes from 464.1 to 419.1 ms. These are the same synthetic activity scenario, not production timings. The first cold-script samples remain in both cohorts.

Browser checks confirm that the decoration is absent until used, then loads with matching container bounds. The same input node, thirty-character synthetic draft and input focus survive activation and stopping. The decoration has no pointer target, is hidden from assistive technology and is absent under reduced motion. Opening activity details and copying controls still use the existing primitives.

**Effect/reference review:** this is an optional rendering adapter; it adds no application capabilities, persistence, new package or server work. Native React boundaries own component loading and the existing libraries own their cleanup. The existing TanStack Start automatic route splitting remains the only route-splitting plugin. This follows the skills' conditional-module guidance while keeping essential conversation content and the composer outside Suspense. Full runtime and hosted checks remain the merge gate.

## Local validation

`pnpm verify` passes: TypeScript, all 1,540 tests in 154 files, seventeen native workerd gates, website build and four Worker builds. Native checks cover SQLite laws, restart/replay, lost acknowledgments, fresh revocation, real retained-agent proxying and ordered cleanup of held streams/credentials/exports. Lint has zero errors and the existing test shadow warning. No dependency pins, infrastructure identities, journal formats, session-check cadence or stream lifetime change.
