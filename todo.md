# Deferred next steps

Recorded on 2026-10-07. Steering and subagents are deferred at the owner's request. Resume implementation when requested.

Baseline: `afa124c`. The app has OptChat-style memory, a tree browser, import/export, and private R2 backups. Messages received during a reply still queue for a fresh turn. Pi already supplies the capabilities below; the remaining work is application integration. The installed versions checked were `@earendil-works/pi-durable` 1.0.4 and `agents` 0.27.0.

## 1. Add mid-run steering

Follow OptChat §§6–8 and Pi's native steering API.

- [ ] Send input for an active session through `session.steer()` or `submit(..., { whenBusy: "steer" })`. Pi delivers it after the current tool round. Keep a fresh session and a settled memory view for a new idle turn.
- [ ] Make admission and recovery durable: retain operation IDs, distinguish accepted input from input the model consumed, and prevent duplicate submissions or archive entries after retries or restarts.
- [ ] Archive mid-run user messages in delivery order alongside committed replies and tool results. Preserve unanswered input on cancellation and handle input arriving just as a run finishes. Check idle input batching against OptChat §7.
- [ ] Update the composer, message status, response grouping, and stop behavior for multiple user messages joining one run.
- [ ] Test tool-boundary delivery, rapid consecutive messages, completion races, cancellation, and Durable Object restart. Verify encrypted reasoning replay and cache usage after a steering message.

Start in [the agent worker](src/agent/worker.ts), [chat contracts](src/shared/contracts.ts), [the chat UI](src/components/chat-app.tsx), and [the cache adapter](src/agent/cache.ts).

## 2. Add optional subagents

OptChat §9 makes subagents optional; the memory system does not require them.

- [ ] Implement replay-safe `spawn(tasks)` using Pi's durable child conversations. Use Pi's ownership records to reuse children after recovery, rather than launching duplicate work.
- [ ] Start each child with a settled view and its assigned task in separate context. Limit its tools explicitly, include `zoom` and `date`, and disable recursive spawning.
- [ ] Implement `tell(id, message)` with native steering. Keep child transcripts and reasoning out of the main memory log.
- [ ] Follow the background-subagent pattern for nonblocking work. When a spawn group finishes, deliver its combined reports once as a main-log `user` entry containing each child's `[id] report`. Steer an active parent or start a fresh turn when idle; do not make the parent poll for completion.
- [ ] Define child concurrency, model limits, cancellation ownership, and status/stop controls. Test duplicate delivery, child failure, parent cancellation, and restart recovery with work still running.

Start in [the agent registry and lifecycle](src/agent/worker.ts), [memory prompts](src/agent/prompts.ts), and [the chat UI](src/components/chat-app.tsx). Reuse the existing authentication boundary and keep credentials out of prompts, logs, and exports.

## 3. Complete targeted conformance checks

- [ ] Measure actual cache reads with synthetic views spanning the 50,000, 80,000, and 100,000-character boundaries, across turns and after steering. The short hosted smoke test confirmed request compatibility and telemetry, but did not demonstrate long-prefix cache hits.
- [ ] Review tool-result handling against OptChat §7. The specification caps results at 30,000 characters before replay and archival; this app now archives full results. Decide and document the intended policy while preserving access to originals.
- [ ] Run `pnpm verify`, `pnpm lint`, and the secret scan when implementation resumes. Check the hosted owner session, archive ordering, and R2 recovery. Preserve compatibility while Worker and Durable Object versions roll forward separately.

## Reference documents

- [OptChat specification](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449): §6 settling, §7 turn loop and logging, §8 caching, and §9 optional subagents.
- [Cloudflare PiHarness documentation](https://developers.cloudflare.com/agents/harnesses/pi/): native steering, session operations, and durable execution.
- [Pi Durable README](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md#abort-and-subagents): task ownership, abort behavior, and subagent implementation patterns. The installed package also contains this README.
- [Foreground subagent example](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/22-subagent-foreground.ts) and [background subagent example](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/23-subagent-background.ts): replay-safe children, reporting, steering, and stop behavior.
- [Durable Object code updates](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/#code-updates): handling different code versions during rollout.
- [Project memory and recovery documentation](README.md#memory-design), [Effect skill](.agents/skills/effect-ts/SKILL.md), and [Alchemy skill](.agents/skills/alchemy/SKILL.md): existing implementation and repository guidance.

Recheck upstream references against the installed versions before implementing; PiHarness is a beta API.
