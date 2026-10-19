# Send and inference latency

The October 19 production trace for a 1.40-second Send acceptance contained 988 ms in `Inference.discoverCatalog` and 1,110 ms in `Inference.readModelCatalog`. The complete admission operation took 1,130 ms. Its provider model-list fetch alone took 956 ms. This is a real production trace, not a simulated provider. Trace: `27e3de3ad1e1f93f3384f33616447a52`, starting `2026-10-19T22:05:39.546Z`, revision `7a2389d`.

## Changes

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
