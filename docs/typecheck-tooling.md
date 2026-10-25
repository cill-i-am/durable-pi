# Rust TypeScript and Effect tooling

Durable Pi includes [tsrs](https://github.com/oxc-project/tsrs), the compiler in [Cloudflare's announcement](https://blog.cloudflare.com/typescript-rust-port/), and [@yielded/effect-tsrs](https://github.com/yielded-dev/effect-tsrs). Both are pinned development dependencies with platform binaries and integrity hashes. They are not bundled into Workers.

## Enabled checks

| Command | Behavior |
| --- | --- |
| `pnpm typecheck` | tsrs; required by CI |
| `pnpm typecheck:rust` | Alias for the same tsrs check |
| `pnpm typecheck:typescript` | TypeScript 7 comparison and fallback |
| `pnpm lint:effect` | Rust Effect diagnostics; errors fail, warnings and suggestions stay advisory |
| `pnpm test:tooling` | Positive and negative TypeScript/Effect fixtures |
| `pnpm bench:typecheck` | Repeated time, memory, and compatibility measurements |

Static verification runs tsrs, then Rust Effect diagnostics and tooling tests, followed by the existing Oxlint and Oxfmt checks. The CI matrix, native recovery, browser, container, and deployment gates remain unchanged. Existing Oxlint Effect correctness rules remain enforced.

The standalone Effect command uses `--lspconfig '{}'` to activate upstream defaults without altering the existing editor/Oxlint options in `tsconfig.json`. The existing `@effect/tsgo` integration and TypeScript 6 compiler-API compatibility package remain installed. This change does not replace editor services or patch Oxlint again.

## Recursive Zod compatibility

`tsrs@0.18.0-ts7.1.0-dev.20260929` reports TS5115 on `z.record(z.string(), z.json())`, identifying a circular instantiation involving `IsOptionalIn`, `$ZodTypeInternals`, and `$InferZodRecordInput`. Both rich-answer and family-invitation graders used this pattern. Zod 4.6.7 retains the same declarations as the installed 4.6.5, so updating that dependency alone does not remove the recursive type structure.

The graders now share [an archived tool-call schema](../evals/tool-call.ts). Its JSON value schema uses Zod's native `z.lazy` and union of strings, finite numbers, booleans, nulls, arrays, and string-keyed records, matching the runtime construction of [`z.json()`](https://zod.dev/api#json). Explicit `z.ZodType<JSONType, JSONType>` input/output types stop the compiler from expanding Zod's recursive schema internals. There are no casts, ignored errors, excluded source files, dependency patches, or relaxed compiler options. Both compilers pass the complete project with this representation; tsrs is now the default.

Runtime tests compare nested values against `z.json()` and reject non-JSON values at multiple depths. Compiler fixtures import the actual shared schema, check nested input/output types, and reject functions and missing argument records in both compilers. This is an application-level compatibility fix; the original upstream tsrs/Zod expression remains unsupported. The standalone Effect check remains a separate diagnostic pass.

Upstream documents checker-order and other conformance gaps in its [compatibility notes](https://github.com/oxc-project/tsrs/blob/main/docs/COMPATIBILITY.md). Retain the complete project comparison and negative fixtures when upgrading. Passing smoke fixtures alone do not establish compiler equivalence.

## Measurements

The original worktree had 717 TypeScript files and TypeScript 6.0.3. Five-run medians there were 16.39 s / 2,608 MiB for TypeScript and 1.35 s / 1,118 MiB for tsrs, with clean results. **That 12.1x speedup does not describe current main**, which now has TypeScript 7 and additional features.

[The earlier report](typecheck-benchmark-2026-10-25.json) retains the failed tsrs runs before the compatibility fix. Its improvement fields remain `null`. The new comparison uses the same corrected source for both TypeScript 7 and tsrs, so the compiler comparison is not confounded by changing the schema between runs. Reports include exit statuses, package versions, parent revision, and a source/config hash; the parent revision alone does not identify the edits covered by the hash.

[The passing five-run report](typecheck-benchmark-2026-10-25-tsrs-default.json) measures TypeScript 7.0.2 against tsrs on the corrected project:

| Metric | TypeScript 7 | tsrs | Improvement |
| --- | --- | --- | --- |
| Median typecheck time | 16.48 s | 2.06 s | 8.01x faster; 87.5% less time |
| Median peak RSS | 8,992 MiB | 2,795 MiB | 68.9% lower |
| Warmup and measured runs | 6/6 passed | 6/6 passed | Both check the complete project |

Measured time ranges were 14.86–43.93 s for TypeScript 7 and 1.97–2.52 s for tsrs. All samples, including the slower TypeScript run, are retained; the table uses medians. The Effect pass separately took a median 3.85 s / 2,926 MiB. These results were measured on an Apple M1 Pro with 32 GiB RAM and Node 26.10.0, without concurrent task builds or tests.

The standalone Effect scan after the compatibility fix covered 1,503 files: **0 errors, 789 warnings, and 1,716 messages/suggestions**. Advisory findings are left unchanged. Main's lifecycle refactor superseded the original worktree's seven error fixes; this integration does not restore the old implementations.

## Reproduce

```sh
pnpm install --frozen-lockfile
pnpm generate-routes
pnpm lint:effect
pnpm test:tooling
pnpm bench:typecheck
# A failed compiler makes the benchmark exit nonzero after saving its report.
pnpm bench:typecheck --samples 10 --output test-results/typecheck-comparison
```

The benchmark warms each compiler once, then takes five fresh-process samples in rotating order, sequentially, with the same checkout and strict configuration. It uses compiler defaults and no incremental compiler cache. Raw stdout/stderr, timings, and JSON are saved under `test-results/typecheck-benchmark/`. Avoid concurrent builds or tests. macOS uses `/usr/bin/time -l`; Linux requires GNU time. Maximum RSS is the largest process peak, not summed resident memory. Effect's launcher is included in elapsed time. Effect diagnostics do additional work and are not interchangeable with ordinary type checking. These measurements are for local tooling, not production response latency or deployment time.

The tooling tests prove both compilers accept valid code and reject an assignment error, and preserve the shared recursive JSON schema's input/output contract. They also prove the standalone Effect command catches a floating Effect that TypeScript accepts, rejects bare `yield` inside an Effect generator, and accepts `yield*`. Positive Effect cases assert the file was actually checked, guarding against an accidentally disabled diagnostic pass.

Keep optional dependencies enabled. The pinned tsrs release supports macOS ARM64 and Linux ARM64/x64 (GNU and musl). Effect diagnostics also support macOS Intel and Windows x64. On platforms without tsrs binaries, use `pnpm typecheck:typescript`; the default static check and tooling smoke suite require a supported tsrs platform.
