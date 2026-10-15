# Production startup

Baseline: main `5df056f814564e5b4f97d5c3629addd0eb2652ea`, 15 October 2026. The original 5.7–17.3-second range mixed isolated observations; it is not a reliable before/after distribution.

## Measurement protocol

Ten signed-in production reloads use one explicit 390 × 844 viewport, 4× CPU slowdown, 150-ms network latency, 200,000-byte/s download, 93,750-byte/s upload and disabled browser cache. Document visibility is recorded. No local builds or CPU sampling run during the measured cohort. Readiness uses the existing committed-history mark, and CDP Network data separates headers, first body bytes and the initial payload's last bytes. No conversation bodies, credentials or tool inputs/results are retained.

The new baseline has a 5.92-second median and a 5.59–6.24-second range. Session readiness is around four seconds; the initial 168-KB stream takes roughly 0.8 seconds to transfer, followed by roughly 0.6 seconds of client processing/rendering. The historical 17.3-second result did not recur. A separate sampled diagnostic maps the main layout hotspot to Base UI's collapsible panel animation/layout measurement. This identifies work to test; it does not prove the cause of the historical outlier.

The controlled activity fixture reproduces the hidden-panel behavior missing from the original text-only fixture. It runs the real workspace with synthetic read-only APIs. Before/after order alternates; each condition has ten runs under the same browser constraints. Every recorded run verifies its origin. An initial helper-binding mistake was detected and its four probes were discarded. Raw numeric samples and exclusions are in [production-startup-measurements.json](production-startup-measurements.json).

## Increment 1: mount activity details when opened

Production mounted 49 closed activity panels containing 56 hidden code blocks. Removing `keepMounted` uses [Base UI's normal panel lifecycle](https://base-ui.com/react/components/collapsible), deferring closed reasoning and tool details. Open, running and attention states retain the existing presentation and controls.

The activity fixture's median committed-history time changes from 4,765.9 to 4,520.8 ms, about 5.1% earlier. Median script time falls from 674.0 to 429.7 ms. Mounted elements fall from 2,905 to 985 while all twenty responses remain. Group opening, nested tool details, copy-control availability, keyboard collapse/focus and horizontal overflow were checked. Nested disclosure state is ephemeral and can reset when its parent unmounts; durable tool results and receipts remain in their owners.

**Effect/reference review:** this is a view lifecycle change. It adds no backend runtime, cache, detached work or authority bypass. Existing Schema decoding, journals, server admission and scoped streams are unchanged. It follows the reference architecture's separation of interpreted presentation from durable execution and the TanStack skill's guidance to avoid unused rendering work. The activity-presentation tests pass.

## Remaining investigation

Terminal configuration performs a remote authority projection even on repeated identical reads. During the baseline audit, `Agents.synchronizeTerminalAuthority` has a 46-ms median and 515-ms maximum across 53 spans. Fresh identity has a 24-ms median and 95-ms maximum across 115 spans. These samples are audit-influenced; nested spans overlap and must not be summed. A proposed fast path must cache only successful projection acknowledgments, with changed revisions and sticky revocation fences still sent immediately. Owner/session authorization must remain fresh on every request.
