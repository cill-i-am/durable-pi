import { Clock, Effect, Schema } from "effect"

const Marker = Schema.Struct({
  type: Schema.Literal("CUSTOM"),
  name: Schema.Literal("durable-pi.first-text"),
  value: Schema.Struct({
    turnId: Schema.String.check(Schema.isMaxLength(128)),
    attemptId: Schema.String.check(Schema.isMaxLength(128)),
    publishedAt: Schema.Number,
  }),
})

/** Observe only our bounded diagnostic line, across arbitrary transport chunks.
 * Large history lines are discarded by this observer, never buffered or logged.
 * Original bytes flow unchanged through the existing codec/backpressure owner. */
export const makeEventStreamLatency = Effect.sync(() => {
  const decoder = new TextDecoder()
  let line = ""
  let discarded = false
  let pending:
    | {
        turnId: string
        attemptId: string
        publishedAt: number
        proxyReceivedAt: number
      }
    | undefined
  const receive = (chunk: Uint8Array) =>
    Effect.gen(function* () {
      const text = decoder.decode(chunk, { stream: true })
      let start = 0
      for (;;) {
        const end = text.indexOf("\n", start)
        const part = text.slice(start, end < 0 ? undefined : end)
        if (!discarded) {
          if (line.length + part.length > 2048) {
            line = ""
            discarded = true
          } else line += part
        }
        if (end < 0) break
        if (
          !discarded &&
          line.startsWith(
            'data: {"type":"CUSTOM","name":"durable-pi.first-text",'
          )
        ) {
          const parsed = Schema.decodeUnknownOption(
            Schema.fromJsonString(Marker)
          )(line.slice(6))
          if (parsed._tag === "Some")
            pending = {
              ...parsed.value.value,
              proxyReceivedAt: yield* Clock.currentTimeMillis,
            }
        }
        line = ""
        discarded = false
        start = end + 1
      }
    })
  const output = Effect.gen(function* () {
    if (!pending) return undefined
    const result = { ...pending, proxyOutputAt: yield* Clock.currentTimeMillis }
    pending = undefined
    return result
  })
  return { receive, output }
})
