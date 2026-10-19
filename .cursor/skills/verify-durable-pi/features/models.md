# Model selection and long-running context

Choose a model profile for a message or job, inspect usage, and let long requests compact their working context without losing saved originals.

## Sub-features

- `models-connect`: Use the shared server-side ChatGPT subscription connection.
- `models-profiles`: Choose Auto, Fast, Balanced, Deep, or supported advanced reasoning settings.
- `models-jobs`: Set per-agent defaults for conversation and supported specialized jobs, including memory.
- `models-pins`: Retain the admitted route and context policy through steering and recovery.
- `models-context`: Compact long active runs while preserving retrievable original messages and tool relationships.
- `models-usage`: Inspect requested/reported models, duration, outcome, and reported input/cache/output tokens.

## How to get to it (user POV)

- Open the model controls above the composer for the next message.
- Open `/agents/AGENT_SLUG/settings/models` for job defaults, or `/agents/AGENT_SLUG/settings/model-access` for connection status.
- Inspect model records through Activity. Use Memory for older originals rather than treating a compacted context as deletion.

## Driving it with the verification harness

Preconditions: The account must have model access. Tests use synthetic model responses unless explicitly labeled live.

- **Connection recovery.** Run `pnpm test:browser tests/browser/family.spec.ts --project=desktop --grep 'admin reconnects ChatGPT'` for connection/recovery UI.
- **Routing and pins.** Run `pnpm test tests/inference-routing.test.ts tests/inference-catalog.test.ts tests/inference-usage.test.ts`. Verify supported settings, pinned routes, and unknown-usage treatment.
- **Compaction.** Run `pnpm test tests/planning-compaction.test.ts tests/inference-native.test.ts` for native task/context relationships; broader restart checks use `pnpm verify:native-runtime`.
- **Real-model check.** Select a supported profile, send a bounded test question, and inspect its saved Activity model record after changing the default for subsequent work.
- **Proof.** Keep the chosen setting and saved attempt record. Do not infer a model from answer style.

## Gotchas

- There is no API-key fallback. A subscription connection does not establish every public API model entitlement.
- Settings changes affect new work; they do not rewrite a running request's pinned route.
- OpenAI server-side compaction is not enabled. Native working-context compaction and long-term memory are separate features.
- Usage can be absent; the UI does not invent token counts or API-dollar costs.
