# Rust TypeScript and Effect tooling

Durable Pi includes [tsrs](https://github.com/oxc-project/tsrs), the compiler in [Cloudflare's announcement](https://blog.cloudflare.com/typescript-rust-port/), and [@yielded/effect-tsrs](https://github.com/yielded-dev/effect-tsrs). Both are pinned development dependencies with platform binaries and integrity hashes. They are not bundled into Workers.

## Enabled checks

| Command | Behavior |
| --- | --- |
| `pnpm typecheck` | Existing TypeScript 7 compiler; required by CI |
| `pnpm typecheck:rust` | Experimental tsrs; currently fails on the incompatibility below |
| `pnpm lint:effect` | Rust Effect diagnostics; errors fail, warnings and suggestions stay advisory |
| `pnpm test:tooling` | Positive and negative TypeScript/Effect fixtures |
| `pnpm bench:typecheck` | Repeated time, memory, and compatibility measurements |

Static verification runs TypeScript 7, then Rust Effect diagnostics and tooling tests, followed by the existing Oxlint and Oxfmt checks. The CI matrix, native recovery, browser, container, and deployment gates remain unchanged. Existing Oxlint Effect correctness rules remain enforced.

The standalone Effect command uses `--lspconfig '{}'` to activate upstream defaults without altering the existing editor/Oxlint options in `tsconfig.json`. The existing `@effect/tsgo` integration and TypeScript 6 compiler-API compatibility package remain installed. This change does not replace editor services or patch Oxlint again.

## Compatibility limit

TypeScript 7.0.2 accepts the full project, but `tsrs@0.18.0-ts7.1.0-dev.20260929` reports TS5115 on `z.record(z.string(), z.json())` in `evals/rich-answers/grade.ts`, identifying a circular instantiation involving `IsOptionalIn`, `$ZodTypeInternals`, and `$InferZodRecordInput`.

The error persists with `--singleThreaded` and with `--checkerAssignment go --noLazyMembers`. No files, types, or strict compiler options are excluded to hide it. TypeScript 7 remains the default and required compiler until a tsrs upgrade passes the entire project. The standalone Effect check does not claim ordinary TypeScript validation; the existing compiler owns that separate check.

Upstream documents checker-order and other conformance gaps in its [compatibility notes](https://github.com/oxc-project/tsrs/blob/main/docs/COMPATIBILITY.md). Retain the complete project comparison and negative fixtures when upgrading. Passing smoke fixtures alone do not establish compiler equivalence.

## Measurements

The original worktree had 717 TypeScript files and TypeScript 6.0.3. Five-run medians there were 16.39 s / 2,608 MiB for TypeScript and 1.35 s / 1,118 MiB for tsrs, with clean results. **That 12.1x speedup does not describe current main**, which now has TypeScript 7, additional features, and the compatibility failure.

[The refreshed report](typecheck-benchmark-2026-10-25.json) records current-main measurements, exit statuses, package versions, parent revision, and source/config hash. Failed runs remain compatibility evidence, but the speedup and memory reduction fields are `null`. A faster failed check is not a usable improvement. The parent revision alone does not identify the tooling edits covered by the hash.

The standalone Effect scan on the rebased project covered 1,501 files: **0 errors, 789 warnings, and 1,716 messages/suggestions**. Advisory findings are left unchanged. Main's lifecycle refactor superseded the original worktree's seven error fixes; this integration does not restore the old implementations.

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

The tooling tests prove both compilers accept valid code and reject an assignment error. They also prove the standalone Effect command catches a floating Effect that TypeScript accepts, rejects bare `yield` inside an Effect generator, and accepts `yield*`. Positive cases assert the file was actually checked, guarding against an accidentally disabled diagnostic pass.

Keep optional dependencies enabled. The pinned tsrs release supports macOS ARM64 and Linux ARM64/x64 (GNU and musl). Effect diagnostics also support macOS Intel and Windows x64. On platforms without tsrs binaries, `pnpm typecheck` remains available; the tooling smoke suite requires a supported tsrs platform.
