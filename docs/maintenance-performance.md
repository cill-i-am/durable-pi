# Responsive chat and maintenance performance

Measured 18 October 2026. Raw, synthetic-only evidence is in [maintenance-performance-measurements.json](maintenance-performance-measurements.json). The earlier foreground cache comparison is in [follow-up-cache.md](follow-up-cache.md).

## Goal and success criteria

Maintenance must not gate a chat whose preceding foreground turn has finished. A new turn must start while held summary/backup work remains unfinished; the production reproduction targets less than 250 ms from server acceptance to model start. Preserve committed originals, ordered leaf summarization, conditional backup checkpoints, recovery and native resource ownership. A speed improvement must add no normal-path model or R2 requests and include measured token/cache results, retained-fact checks and green required CI before shipping.

## PR #141 production verification

PR #141 was squash-merged as `56e86fd6afc331afaff0ea5af094c0073eb68ff9`. [Main workflow 39107159464](https://github.com/cill-i-am/durable-pi/actions/runs/39107159464) completed successfully. Cloudflare reported Worker version `e6a43f3c-228a-4813-abc1-e7f648828962` serving 100% of traffic at verification.

An isolated production agent received synthetic messages, with tools and external actions expressly excluded. A follow-up was submitted after the previous answer completed, with the runtime ready and memory not ready. Its committed run records show:

| Event                              | UTC          |
| ---------------------------------- | ------------ |
| Follow-up accepted                 | 07:28:42.785 |
| Pi session and model started       | 07:28:42.858 |
| Follow-up finished                 | 07:28:46.855 |
| Concurrent parent summary finished | 07:28:47.837 |

Acceptance-to-start was **73 ms** (147 ms from the browser's network dispatch). The leaf summary finished at 07:28:42.803; the parent summary began at 07:28:42.861 and overlapped the foreground inference. This establishes that the summary pipeline does not have to drain before chat starts. Backup spans also continued during foreground inference; the held-I/O native regression exercises acceptance and completion with summary and backup Promises kept unresolved.

The follow-up used one model request: 18,585 input, 18,176 cached, 409 uncached, 8 output tokens. That is a 97.8% cache hit fraction on this request, not a future hit-rate guarantee. Browser observation time is not used as a server latency.

## Summary optimization

Background summaries previously advertised the complete live tool registry, although the prompt says to call no tools and the adapter rejects tool-call answers. The candidate omits those schemas and retains the exact existing system instructions, model, reasoning level, byte limit, retry policy and archive context. Foreground prompts and tool availability are unchanged.

The final paired run used current-main instructions after #146, 58 registry tools in the baseline, `gpt-6-luna` with medium reasoning, short implicit caching, distinct stable cache keys per arm and the native owned model-stream adapter. Three synthetic jobs cover a long user instruction, a failed tool result, and a merge with corrected authorization. Each was run twice; arm order was reversed for the second pass. The actual production `summarize` loop enforced 512 UTF-8 bytes and counted any retries. All 12 jobs needed one request and retained the checked amount, date, approval constraint and failure/verification facts.

| Final sample                       | Baseline: tools | Candidate: no tools |
| ---------------------------------- | --------------: | ------------------: |
| Model requests                     |               6 |                   6 |
| Input tokens                       |         102,456 |              15,486 |
| Cached input tokens                |          82,560 |               7,936 |
| Uncached input tokens              |          19,896 |               7,550 |
| Output tokens, including reasoning |             600 |                 600 |
| Median completion                  |      5,319.5 ms |          4,688.5 ms |
| Median first provider event        |      2,358.5 ms |          1,331.5 ms |
| Median first text                  |        4,014 ms |          4,075.5 ms |

Input fell **84.9%**, uncached input **62.1%**, and median completion **11.9%**. The candidate removes exactly 14,495 input tokens per sampled job. Median first text did not improve. This is a small sample, not a latency SLO or billing claim.

Cache behavior matters: the candidate had one cache miss in its second pass (2,512 uncached tokens versus the baseline's 495). Its other second-pass jobs had 991 and 144 uncached tokens, versus 894 and 303. The smaller prompt carries much less cached material, so cache percentage alone is misleading. Provider routing and 128-token cache blocks can change individual results. The aggregate input reduction is exact for these fixtures; a per-request uncached reduction is not guaranteed.

An explored compactor-only system prompt was rejected: it had no cache hits in six requests and increased repeated-job uncached input from 454 to 3,624 tokens. The existing instructions are retained rather than adding filler for caching. The initial no-tools trial, followed by #146's prompt update, is recorded separately. All exploration and final measurements together consumed **30 model requests, 241,764 input tokens and 3,297 output tokens**. This is measurement usage, not the runtime's ongoing overhead. Production synthetic verification requests are separate from that benchmark total.

## Backup optimization

A production `Memory.backup` trace took 4,403 ms. It contained five serial R2 requests: progress GET 316 ms, immutable batch PUT 704 ms, conditional progress PUT 618 ms, immutable snapshot PUT 575 ms, latest PUT 2,188 ms. Trace ID: `3167996d45a8acf3c855daad40e47eab`.

Once every batch is uploaded, the conditional progress write and immutable snapshot write can run together. `latest.json` still waits for both successful results. This changes five serial stages to four, with the same five requests, zero model calls and zero model tokens. A failed conditional write may leave an unpublished immutable snapshot; it cannot publish a new latest backup. Failure and shutdown still join all unabortable native R2 Promises.

[Cloudflare documents R2's strong consistency and atomic conditional writes](https://developers.cloudflare.com/r2/reference/consistency/). We retain the existing publication barrier and format. Parent summaries may run concurrently where already eligible; leaf order remains unchanged because later leaf summaries require complete prior context.

[The replay JSON](maintenance-backup-replay.json) records a controlled run of both real implementations using the measured R2 call durations: **4,455 → 3,867 ms** (13.2% faster), with five requests in each arm. It is a dependency/critical-path measurement, not a new live R2 measurement. New production backup and summary timings remain a post-deployment check for this follow-on change.

## Validation

Static checks, typechecking, lint, formatting, 1,881 unit tests and production website/Worker builds passed locally. Added regressions hold both backup writes, release them in either order, fail either write, reject a conditional checkpoint, and dispose the actor while both native writes are live. They verify that latest publication waits, the last complete backup remains restorable, and ownership lasts until native settlement. Summary transport coverage verifies unchanged instructions and an empty advertised tool list.
