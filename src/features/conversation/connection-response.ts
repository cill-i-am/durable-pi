import { Cause, Schema } from "effect"

/** TanStack owns SSE parsing but does not await reader.cancel(). This response
 * bridge retains that native settlement without changing the protocol parser. */
export function ownConversationResponse(response: Response) {
  if (!response.body) return { response, close: () => Promise.resolve() }
  const reader = response.body.getReader()
  let settlement: Promise<void> | undefined
  const close = (reason?: unknown) => {
    if (!settlement) {
      settlement = reader.cancel(reason).finally(() => reader.releaseLock())
      // The SDK may ignore its cancellation Promise. The request owner observes
      // the exact Promise on replacement/exit, including a late rejection.
      void settlement.catch(() => {})
    }
    return settlement
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read()
        if (result.done) {
          controller.close()
          if (!settlement) {
            reader.releaseLock()
            settlement = Promise.resolve()
          }
        } else
          controller.enqueue(
            Schema.decodeUnknownSync(Schema.Uint8Array)(result.value)
          )
      } catch (cause) {
        if (!settlement) {
          // An errored source is already terminal; cancelling it only rejects
          // with that same read error, which is not a second cleanup defect.
          reader.releaseLock()
          settlement = Cause.isCause(cause)
            ? Promise.reject(cause)
            : Promise.resolve()
          void settlement.catch(() => {})
        }
        controller.error(cause)
      }
    },
    cancel: close,
  })
  return { response: new Response(body, response), close }
}

export async function closeConversationResponse(
  owned: ReturnType<typeof ownConversationResponse> | undefined,
  primary?: unknown
) {
  try {
    await owned?.close()
  } catch (cleanup) {
    const cause = Cause.isCause(cleanup) ? cleanup : Cause.die(cleanup)
    throw primary === undefined || primary === cleanup
      ? cause
      : Cause.combine(
          Cause.isCause(primary) ? primary : Cause.fail(primary),
          cause
        )
  }
}
