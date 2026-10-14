import { Schema } from "effect"
import {
  CodeOutput,
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

export async function readOutput(
  response: Response,
  signal?: AbortSignal
): Promise<CodeOutput> {
  if (!response.ok || !response.body) throw new Error("Execution failed")
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = []
  let length = 0
  const abort = () => {
    void reader.cancel().catch(() => {})
  }
  signal?.addEventListener("abort", abort, { once: true })
  if (signal?.aborted) abort()
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > 200000) {
        await reader.cancel()
        throw new Error("Execution output exceeded its limit")
      }
      chunks.push(next.value)
    }
  } finally {
    signal?.removeEventListener("abort", abort)
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return Schema.decodeUnknownSync(CodeOutput)(
    JSON.parse(new TextDecoder().decode(bytes))
  )
}

export async function executeCode(
  loader: WorkerLoader,
  input: CodeInput,
  signal: AbortSignal
) {
  const isolated = loader.load({
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
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener("abort", abort, { once: true })
  if (signal.aborted) abort()
  let timer: ReturnType<typeof setTimeout> | undefined
  const stopped = new Promise<never>((_, reject) => {
    const fail = () => reject(new Error("Execution stopped or timed out"))
    controller.signal.addEventListener("abort", fail, { once: true })
    if (controller.signal.aborted) fail()
    timer = setTimeout(abort, EXECUTION_TIMEOUT_MS)
  })
  try {
    return await Promise.race([
      isolated
        .getEntrypoint()
        .fetch(
          new Request("https://execution.internal/run", {
            method: "POST",
            redirect: "manual",
            body: input.data,
            signal: controller.signal,
          })
        )
        .then((response) => readOutput(response, controller.signal)),
      stopped,
    ])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", abort)
    controller.abort()
  }
}
