import { Effect } from "effect"
import { observeCleanup } from "../../shared/effect"
import { ExecutorUnavailable } from "../executor"
import { executionResponse, type ExecutionTransport } from "./interop"
import { readOutput } from "./output"
import {
  EXECUTION_CPU_MS,
  EXECUTION_TIMEOUT_MS,
  type CodeInput,
} from "../contracts"

export const RUNNER_MODULE = `export default { async fetch(request) {
  let logs = '';
  const format = value => typeof value === 'string' ? value : JSON.stringify(value);
  const log = (...values) => { if (logs.length < 16000) logs += values.map(format).join(' ').slice(0, 16000 - logs.length) + '\\n'; };
  const outputConsole = Object.freeze({log, info: log, warn: log, error: log, debug: log});
  Object.defineProperty(globalThis, 'console', { value: outputConsole });
  try {
    const { default: run } = await import('user.js');
    const value = await run(await request.json(), outputConsole);
    const result = JSON.stringify(value ?? null);
    if (result.length > 32768) throw new Error('Result exceeds 32768 characters. Return a smaller result.');
    return Response.json({ result, logs: logs.slice(0, 16000), error: null });
  } catch (error) {
    return Response.json({ result: '', logs: logs.slice(0, 16000), error: String(error?.message || error).slice(0, 1000) });
  }
} };`

/** Native subset consumed here; the real WorkerLoader satisfies this contract. */
export interface ExecutionLoader {
  load: (code: WorkerLoaderWorkerCode) => {
    getEntrypoint: () => ExecutionTransport
  }
}

/** CPU/network isolation remains native; Effects own request and body lifetime. */
export const executeCode = Effect.fn("Execution.executeCode")(
  (loader: ExecutionLoader, input: CodeInput) =>
    Effect.yieldNow.pipe(
      Effect.andThen(
        observeCleanup(
          Effect.scoped(
            Effect.gen(function* () {
              const entrypoint = yield* Effect.try({
                try: () =>
                  loader
                    .load({
                      compatibilityDate: "2026-09-25",
                      mainModule: "runner.js",
                      modules: {
                        "runner.js": RUNNER_MODULE,
                        "user.js": `export default async function(input, console) {\n${input.code}\n}`,
                      },
                      env: {},
                      globalOutbound: null,
                      limits: { cpuMs: EXECUTION_CPU_MS, subRequests: 0 },
                    })
                    .getEntrypoint(),
                catch: () => new ExecutorUnavailable(),
              })
              const response = yield* executionResponse((signal) =>
                entrypoint.fetch(
                  new Request("https://execution.internal/run", {
                    method: "POST",
                    redirect: "manual",
                    body: input.data,
                    signal,
                  })
                )
              )
              return yield* readOutput(response)
            })
          ),
          (observed) =>
            observed.pipe(
              Effect.timeoutOrElse({
                duration: EXECUTION_TIMEOUT_MS,
                orElse: () => new ExecutorUnavailable(),
              })
            )
        )
      )
    )
)
