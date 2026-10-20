import { Duplex } from "node:stream"
import { constants, createGzip } from "node:zlib"

import { Effect, Schema } from "effect"

function acceptsGzip(value: string | null) {
  let wildcard = false
  for (const entry of (value ?? "").toLowerCase().split(",")) {
    const [coding, ...parameters] = entry.trim().split(";")
    if (coding !== "gzip" && coding !== "*") continue
    const quality = parameters.find((part) => part.trim().startsWith("q="))
    const q = quality?.trim().slice(2)
    const accepted =
      q === undefined ||
      (/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(q) && Number(q) > 0)
    if (coding === "gzip") return accepted
    wildcard = accepted
  }
  return wildcard
}

/** Website transport adapter. The returned body owns its codec and upstream
 * reader; application streams and schemas stay intact. */
export const encodeEventStream = Effect.fn("Website.encodeEventStream")(
  (request: Request, response: Response) =>
    Effect.sync(() => {
      if (
        request.method !== "GET" ||
        response.status !== 200 ||
        !response.body ||
        /(?:^|,)\s*no-transform\s*(?:,|$)/i.test(
          response.headers.get("cache-control") ?? ""
        ) ||
        response.headers.get("content-type")?.split(";")[0]?.trim() !==
          "text/event-stream" ||
        response.headers.has("content-encoding")
      )
        return response

      const vary = response.headers.get("vary")
      if (
        !vary
          ?.split(",")
          .some(
            (value) =>
              value.trim().toLowerCase() === "accept-encoding" ||
              value.trim() === "*"
          )
      )
        response.headers.set(
          "Vary",
          vary ? `${vary}, Accept-Encoding` : "Accept-Encoding"
        )
      // Workers can normalize this header. An empty original value also matters.
      const original = request.cf?.clientAcceptEncoding
      if (
        !acceptsGzip(
          typeof original === "string"
            ? original
            : request.headers.get("accept-encoding")
        )
      )
        return response

      const headers = new Headers(response.headers)
      headers.set("Content-Encoding", "gzip")
      headers.delete("Content-Length")
      const codec = Duplex.toWeb(createGzip({ flush: constants.Z_SYNC_FLUSH }))
      const reader = codec.readable.getReader()
      const writer = codec.writable.getWriter()
      const cancellation = new Error("Event stream closed")
      let output!: ReadableStreamDefaultController<Uint8Array>
      // Node and DOM disagree on BYOB types. Bridge bytes without casting their
      // stream interfaces, preserving backpressure and failure in both directions.
      const writable = new WritableStream<Uint8Array>({
        start(controller) {
          void writer.closed.catch((cause) => controller.error(cause))
        },
        write: (chunk) => writer.write(chunk),
        close: () => writer.close(),
        abort: (cause) => writer.abort(cause),
      })
      const stop = async () => {
        await reader.cancel(cancellation)
        try {
          await pumping
        } catch (cause) {
          if (cause !== cancellation) throw cause
        }
      }
      const disconnected = () => {
        void stop().catch((cause) => output.error(cause))
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          output = controller
        },
        async pull(controller) {
          const next = await reader.read()
          if (next.done) controller.close()
          else
            controller.enqueue(
              new Uint8Array(
                Schema.decodeUnknownSync(Schema.Uint8Array)(next.value)
              )
            )
        },
        cancel: stop,
      })
      // Acquire upstream before handoff. Workers' JS pipeTo does not reliably
      // handle AbortSignal, so interrupt the codec directly on client disconnect.
      const pumping = response.body
        .pipeTo(writable)
        .finally(() =>
          request.signal.removeEventListener("abort", disconnected)
        )
      void pumping.catch((cause) => output.error(cause))
      request.signal.addEventListener("abort", disconnected, { once: true })
      if (request.signal.aborted) disconnected()
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers,
        encodeBody: "manual",
      })
    })
)
