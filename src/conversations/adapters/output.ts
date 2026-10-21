import { Effect } from "effect"

/** One producer reserves a queue slot for a complete SSE batch. Reader demand
 * wakes it; cancellation removes the waiter. Heartbeats never consume a
 * reservation or treat queued data as a broken connection. */
export function conversationOutput(
  controller: ReadableStreamDefaultController<Uint8Array>,
  closed: () => boolean
) {
  const encoder = new TextEncoder()
  let wake: (() => void) | undefined
  let reserved = false
  let reported = false
  const awaitPull = Effect.callback<void>((resume) => {
    if (closed() || (controller.desiredSize ?? 0) > 0)
      return resume(Effect.void)
    const waiting = () => {
      if (wake === waiting) wake = undefined
      resume(Effect.void)
    }
    wake = waiting
    return Effect.sync(() => {
      if (wake === waiting) wake = undefined
    })
  })
  const reserve = Effect.gen(function* () {
    while (!closed() && (controller.desiredSize ?? 0) <= 0) {
      if (!reported) {
        reported = true
        yield* Effect.logInfo("Conversation.streamBackpressure").pipe(
          Effect.annotateLogs({ desiredSize: controller.desiredSize })
        )
      }
      yield* awaitPull
    }
    reserved = !closed()
  })
  const enqueue = (value: string) => {
    if (closed() || (controller.desiredSize ?? 0) <= 0) return false
    controller.enqueue(encoder.encode(value))
    return true
  }
  return {
    reserve,
    enqueue,
    diagnostic: (value: string) => !reserved && enqueue(value),
    release: () => {
      reserved = false
    },
    pull: () => wake?.(),
    heartbeat: () =>
      !closed() &&
      (reserved ||
        (controller.desiredSize ?? 0) <= 0 ||
        enqueue(": keepalive\n\n")),
  }
}
