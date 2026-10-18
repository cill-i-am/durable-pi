# Follow-up responsiveness: token and cache measurement

Measured on 18 October 2026 before deployment, for draft PR #141. The first fallback was too expensive for large pending tool results. The revised fallback bounds that overhead and preserves cache reuse without waiting for summaries or backups.

## Final paired result

These are actual provider-reported counts from GPT-6.1 Sol at medium reasoning, with the agent's 51 default tool schemas. Both arms used the same frozen synthetic history and identical five-token `OK` outputs. The baseline used the pre-change system prompt, completed summaries, and previous payload format. The candidate used the current system prompt, pending originals and current payload formatter.

| Working context | Baseline input | Revised input | Difference | Cached input on first changed context, baseline / revised | Uncached input, baseline / revised |
| --- | --: | --: | --: | --: | --: |
| Summaries ready | 17,395 | 17,400 | +5 (+0.03%) | See warm repeat below | See warm repeat below |
| Two ordinary pending messages | 17,445 | 17,450 | +5 (+0.03%) | 17,280 / 17,280 | 165 / 170 |
| One large pending tool result | 17,571 | 18,361 | +790 (+4.50%) | 17,280 / 17,280 | 291 / 1,081 |
| Three exchanges awaiting summaries | 17,923 | 19,171 | +1,248 (+6.96%) | 17,408 / 17,280 | 515 / 1,891 |

The revised prompt's cache hit rates on changed context were 99.0%, 94.1% and 90.1%, respectively. Repeating exactly the same prompt produced 99.3%, 99.0%, 99.0% and 99.5% cache hits for ready, ordinary, large-result and stalled cases. Identical repeats are an upper bound on reuse, not a promise for changing chats. New instructions also need to warm their cache after rollout.

The sixteen final comparison requests had median time to first output of 3.02 seconds for the baseline and 2.75 seconds for the candidate. This small sample is not evidence of a general inference speedup. It measures the provider request, excluding the old wait for background work. The native runtime regression separately verifies that production admission, context pinning, Pi execution and turn completion all finish while summary and backup IO remain held.

## What the measurement changed

The original 128,000-byte fallback allowed a synthetic 66 KB tool result to grow foreground input from 17,530 to 31,200 tokens (+78%). A three-exchange stalled backlog grew it from 17,882 to 41,364 tokens (+131%), also displacing the saved-summary prefix. Those exploratory counts used an earlier instruction snapshot; compare within each pair, not across snapshots.

Pending originals now receive an 8,192-byte allowance in total and at most 4,096 bytes per entry. Saved summaries retain their place ahead of the backlog. Messages within that allowance stay exact. Larger entries contain explicit head/tail excerpt markers; omitted entries remain retrievable with `search_memory` and `zoom`. The complete archive is unchanged, including exact Unicode and amounts. The existing 128,000-byte overall working-context limit still applies.

The large-prompt trial also received two HTTP 400 responses: `prompt_cache_breakpoint is not supported on this model`. The application had inserted these fields even though the ChatGPT subscription route rejected them. The payload now uses supported consecutive context messages, with boundaries around 4,000 characters at whole line endings, and a separate current-request message with its attachments. It preserves native encrypted reasoning and tool-result replay, the stable per-agent cache key and `store: false`.

An intermediate bounded version without these message boundaries used 2,695, 3,596 and 4,395 uncached tokens for ordinary, large-result and stalled changed contexts. The final paired run reduced these to 170, 1,081 and 1,891 while using the provider's implicit cache. OpenAI documents that unchanged prefixes and eligible message endings matter for [prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching). Actual endpoint acceptance and reported usage, rather than assumed support, determined this change.

No extra foreground model call was introduced for packaging context. Background summary scheduling, the summary model and retry policy remain in place; backups use no model tokens. Summaries still consume their normal tokens eventually. In this fixture one common background summary cost 28,022 input tokens and 97 output tokens on GPT-6 Luna. It was generated once and reused in both comparison arms.

## Method and limits

The fixture contains 64 saved-summary leaves, two short pending messages including the exact amount €42.75 and a clover emoji, and a four-entry browser exchange with 160 synthetic gallery records. The stalled case repeats that exchange three times. No private chat content or credentials were saved in the evidence. The default tool schemas and instruction sections were extracted from a disposable local workerd `PersonalAgentProbe` using the production registry.

Requests used the production `createAgentModels` adapter, Pi SDK 1.3.0, the existing local development ChatGPT OAuth connection, GPT-6.1 Sol and medium reasoning. No API-key fallback, production message or deployment was used. Stable separate per-arm keys were reused throughout each matrix. First requests ran baseline then candidate; repeat requests reversed that order. The final baseline's outgoing memory message was restored to the old two-text-block format after adapter processing, so the candidate's message segmentation did not accidentally benefit the baseline. All baseline views were below the old explicit-breakpoint threshold.

Counts come from completed provider events: input, cached input, output and cache writes. Uncached input is input minus cached input; output already includes reasoning tokens. Cache writes were reported as zero on this connection. These are request-usage figures, not an invoice or a claim about ChatGPT subscription quota accounting.

Across the successful probe and all exploratory/final trials, measurement used 55 completed requests: 1,045,398 input tokens, of which 786,944 were cached and 258,454 uncached, plus 367 output tokens. Two rejected requests supplied no usage report and are excluded. Full numerical results and source fingerprints are in [the measurement JSON](./follow-up-cache-measurements.json).

The benchmark deliberately fixes output and executes no tools. It isolates input/cache overhead; it does not measure end-to-end answer quality or a production latency distribution. A follow-up that needs omitted details may require retrieval and another model request. The saved archive and retrieval behavior are covered by unit/native tests, but that additional model usage is not included in the table. Limits are bytes, not a universal token cap: different languages and content tokenize differently.

## Verification

- Required static checks and Worker builds pass.
- All 178 unit-test files / 1,829 tests pass.
- The complete native communication runtime suite passes, including foreground completion with held summary and backup IO, no overlapping maintenance attempt, wake retention, restart recovery and exact archive retrieval.
- Cache regressions cover stable context boundaries, complete Unicode lines, current-request attachments, encrypted reasoning and tool replay, and omission of rejected provider fields.

The change remains undeployed. CI must pass for the final pushed commit before any later rollout decision.
