import { Cause, Exit, Schema } from "effect"

function live(signal: AbortSignal) {
  if (signal.aborted) throw new Error("Stopped")
}
/** Native reader ownership is shared by command and file SDK callbacks. The
 * owning Effect adapter interprets this local Cause without flattening cleanup. */
export async function withReader<T>(
  stream: ReadableStream<unknown>,
  signal: AbortSignal,
  use: (read: () => Promise<ReadableStreamReadResult<Uint8Array>>) => Promise<T>
): Promise<T> {
  let reader: ReadableStreamDefaultReader<unknown>
  try {
    reader = stream.getReader()
  } catch (cause) {
    throw Cause.die(cause)
  }
  const state: { ended: boolean; cancellation?: Promise<void> } = {
    ended: false,
  }
  const cancel = () => (state.cancellation ??= reader.cancel())
  const stop = () => {
    void cancel().catch(() => {
      /* joined below */
    })
  }
  signal.addEventListener("abort", stop, { once: true })
  if (signal.aborted) stop()
  let result: Exit.Exit<T, unknown>
  let problem: { cause: unknown } | undefined
  try {
    live(signal)
    result = Exit.succeed(
      await use(async () => {
        let item: ReadableStreamReadResult<unknown>
        try {
          item = await reader.read()
        } catch (cause) {
          state.ended = true
          throw cause
        }
        state.ended = item.done
        if (item.done) return { done: true, value: undefined }
        if (!Schema.is(Schema.Uint8Array)(item.value))
          throw new Error("Invalid byte stream chunk")
        return { done: false, value: item.value }
      })
    )
  } catch (cause) {
    problem = { cause }
    result = Exit.failCause(Cause.isCause(cause) ? cause : Cause.fail(cause))
  }
  signal.removeEventListener("abort", stop)
  const failures: Cause.Reason<unknown>[] = Exit.isFailure(result)
    ? [...result.cause.reasons]
    : []
  try {
    if (state.cancellation || !state.ended) await cancel()
  } catch (cause) {
    failures.push(Cause.makeDieReason(cause))
  }
  try {
    reader.releaseLock()
  } catch (cause) {
    failures.push(Cause.makeDieReason(cause))
  }
  const primaryReasons = Exit.isFailure(result)
    ? result.cause.reasons.length
    : 0
  if (failures.length > primaryReasons) throw Cause.fromReasons(failures)
  if (problem) throw problem.cause
  if (Exit.isSuccess(result)) return result.value
  throw result.cause
}
export function readBounded(
  stream: ReadableStream<unknown>,
  limit: number,
  signal: AbortSignal
) {
  return withReader(stream, signal, async (read) => {
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const item = await read()
      live(signal)
      if (item.done) break
      size += item.value.length
      if (size > limit) throw new Error("Output limit")
      chunks.push(item.value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    return bytes
  })
}
