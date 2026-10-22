import { DurableObject } from "cloudflare:workers"
import { Effect } from "effect"

import { upstreamDiagnostic } from "../../src/agent/adapters/upstream"
import { observedUpstreamFetch } from "../../src/inference/adapters/upstream-worker"
export { UpstreamRelay } from "../../src/inference/adapters/upstream-worker"

type ProbeEnv = { PROBE: DurableObjectNamespace<UpstreamProbe>; DELAY: Fetcher }
export class UpstreamProbe extends DurableObject<ProbeEnv> {
  private sink?: WritableStream<Uint8Array>
  async observeUpstream(_id: string, sink: WritableStream<Uint8Array>) {
    if (this.sink) {
      await sink.abort()
      return false
    }
    this.sink = sink
    return true
  }
  async releaseUpstream() {
    const sink = this.sink
    this.sink = undefined
    if (sink) await sink.abort().catch(() => {})
  }
  async fetch(request: Request) {
    const mode = new URL(request.url).searchParams.get("mode") ?? "baseline"
    let sink = this.sink!
    this.sink = undefined
    if (mode === "slow-observer") {
      const writer = sink.getWriter()
      sink = new WritableStream<Uint8Array>({
        async write(bytes) {
          await new Promise((done) => setTimeout(done, 500))
          await writer.write(bytes)
        },
        close: () => writer.close(),
        abort: (reason) => writer.abort(reason),
      })
    }
    const abort = new AbortController()
    const task = observedUpstreamFetch(
      this.ctx.exports.UpstreamRelay,
      new Request("https://api.openai.com/v1/responses", {
        method: "POST",
        body: mode,
        signal: abort.signal,
      }),
      sink,
      { turnId: mode, attemptId: "attempt" }
    )
    if (mode === "abort-headers") {
      setTimeout(() => abort.abort(), 40)
      await task.catch(() => {})
      return new Response("cancelled")
    }
    const response = await task
    if (mode === "gate")
      await this.ctx.blockConcurrencyWhile(() =>
        this.env.DELAY.fetch("http://fixture/delay")
      )
    if (mode === "unread") await this.env.DELAY.fetch("http://fixture/delay")
    if (mode === "cancel-body") {
      await response.body!.cancel()
      return new Response("cancelled")
    }
    return new Response(await response.text(), {
      status: response.status,
      headers: response.headers,
    })
  }
}
export default {
  async fetch(request: Request, env: ProbeEnv, ctx: ExecutionContext) {
    const url = new URL(request.url)
    if (url.pathname === "/race-eof") {
      let finishClose!: () => void, beganClose!: () => void
      const held = new Promise<void>((done) => {
        finishClose = done
      })
      const started = new Promise<void>((done) => {
        beganClose = done
      })
      let closes = 0,
        disposals = 0
      const remote = {
        response: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                c.close()
              },
            })
          ),
        cancel: async () => {
          closes++
          beganClose()
          await held
        },
        [Symbol.dispose]() {
          disposals++
        },
      }
      const response = await observedUpstreamFetch(
        { start: async () => remote },
        new Request("https://api.openai.com/v1/responses", { method: "POST" }),
        new WritableStream(),
        { turnId: "race", attemptId: "attempt" }
      )
      const reader = response.body!.getReader()
      const pending = reader.read()
      await started
      const cancelling = reader.cancel()
      finishClose()
      const results = await Promise.allSettled([pending, cancelling])
      return Response.json({
        statuses: results.map((result) => result.status),
        closes,
        disposals,
      })
    }
    if (url.hostname === "api.openai.com") {
      const mode = await request.text()
      if (mode === "abort-headers")
        await new Promise((done) => setTimeout(done, 700))
      if (mode === "past-expiry")
        await new Promise((done) => setTimeout(done, 61_000))
      return new Response(
        new ReadableStream<Uint8Array>({
          type: "bytes",
          async start(controller) {
            controller.enqueue(new TextEncoder().encode(": headers\n\n"))
            await new Promise((done) => setTimeout(done, 200))
            try {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"type":"response.output_text.delta","delta":"synthetic"}\n\n'
                )
              )
              controller.close()
            } catch {}
          },
        }),
        {
          status: 202,
          headers: {
            "content-type": "text/event-stream",
            "x-upstream": "retained",
          },
        }
      )
    }
    if (url.pathname === "/delay") {
      await new Promise((done) => setTimeout(done, 700))
      return new Response("released")
    }
    if (url.pathname === "/health") return new Response("ok")
    const peer = env.PROBE.getByName(url.searchParams.get("mode") ?? "baseline")
    if (url.pathname === "/observe")
      return Effect.runPromise(
        upstreamDiagnostic(peer, request, (task) => ctx.waitUntil(task)).pipe(
          Effect.scoped
        )
      )
    return peer.fetch(request)
  },
}
