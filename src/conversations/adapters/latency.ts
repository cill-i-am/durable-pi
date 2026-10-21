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
export const makeFirstTextLatency = Effect.sync(() => {
  const decoder = new TextDecoder()
  let line = ""
  let discarded = false
  let pending:
    | {
        turnId: string
        attemptId: string
        publishedAt: number
        receivedAt: number
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
              receivedAt: yield* Clock.currentTimeMillis,
            }
        }
        line = ""
        discarded = false
        start = end + 1
      }
    })
  const output = Effect.gen(function* () {
    if (!pending) return undefined
    const result = { ...pending, outputAt: yield* Clock.currentTimeMillis }
    pending = undefined
    return result
  })
  return { receive, output }
})

/** Opt-in gateway probe. One bounded reader preserves bytes, backpressure and
 * cancellation. The observer receives IDs and clocks only, never message text. */
export const observeFirstText = Effect.fn("Conversations.observeFirstText")(
  (
    response: Response,
    observe: (trace: {
      turnId: string
      attemptId: string
      publishedAt: number
      receivedAt: number
    }) => void
  ) =>
    Effect.gen(function* () {
      if (
        !response.body ||
        response.status !== 200 ||
        response.headers.get("content-type")?.split(";")[0]?.trim() !==
          "text/event-stream"
      )
        return response
      const latency = yield* makeFirstTextLatency
      const reader = response.body.getReader()
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read()
            if (next.done) {
              reader.releaseLock()
              controller.close()
              return
            }
            const bytes = Schema.decodeUnknownSync(Schema.Uint8Array)(
              next.value
            )
            Effect.runSync(latency.receive(bytes))
            const trace = Effect.runSync(latency.output)
            if (trace) {
              try {
                observe(trace)
              } catch {}
            }
            controller.enqueue(bytes)
          } catch (cause) {
            reader.releaseLock()
            controller.error(cause)
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason)
          } finally {
            reader.releaseLock()
          }
        },
      })
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    })
)
