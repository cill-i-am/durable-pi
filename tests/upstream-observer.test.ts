import { Deferred, Effect } from "effect"
import { expect, it } from "vitest"

import {
  upstreamResponse,
  upstreamTextDetector,
} from "../src/inference/adapters/upstream"

it("detects a nonempty provider text delta across every byte boundary without retaining content", () => {
  const encoded = new TextEncoder().encode(
    'data: {"type":"response.output_text.delta","delta":"private 🌍"}\r\n\r\n'
  )
  for (let split = 0; split <= encoded.length; split++) {
    const detect = Effect.runSync(upstreamTextDetector)
    const first = detect(encoded.slice(0, split))
    const second = detect(encoded.slice(split))
    expect(first || second).toBe(true)
    expect(detect(encoded)).toBe(false)
  }
})
it("ignores reasoning, empty deltas, malformed and oversized lines, and resumes at the next line", () => {
  const detect = Effect.runSync(upstreamTextDetector)
  const encode = (text: string) => new TextEncoder().encode(text)
  expect(
    detect(
      encode('data: {"type":"response.reasoning.delta","delta":"private"}\n')
    )
  ).toBe(false)
  expect(
    detect(encode('data: {"type":"response.output_text.delta","delta":""}\n'))
  ).toBe(false)
  expect(detect(encode("data: invalid\n"))).toBe(false)
  expect(detect(encode("x".repeat(20_000)))).toBe(false)
  expect(
    detect(
      encode('\ndata: {"type":"response.output_text.delta","delta":"yes"}\n')
    )
  ).toBe(true)
})
it("bounds upstream read ahead and joins source cancellation when the actor never reads", async () => {
  let pulls = 0
  let cancelled = false
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++
        controller.enqueue(new Uint8Array(16_384))
      },
      cancel() {
        cancelled = true
      },
    })
  )
  const ready = Effect.runSync(Deferred.make<Response>())
  const work = Effect.runPromiseExit(
    upstreamResponse(response, ready, () => {}).pipe(Effect.scoped)
  )
  const output = await Effect.runPromise(Deferred.await(ready))
  await new Promise((done) => setTimeout(done, 20))
  expect(pulls).toBeLessThanOrEqual(7)
  await output.body!.cancel()
  await work
  expect(cancelled).toBe(true)
})
it("preserves response bytes and status while inspecting only one first-text marker", async () => {
  const bytes = new TextEncoder().encode(
    ': keepalive\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n'
  )
  const ready = Effect.runSync(Deferred.make<Response>())
  const stages: string[] = []
  const work = Effect.runPromiseExit(
    upstreamResponse(
      new Response(bytes, {
        status: 202,
        headers: { "x-upstream": "retained" },
      }),
      ready,
      (stage) => stages.push(stage)
    ).pipe(Effect.scoped)
  )
  const response = await Effect.runPromise(Deferred.await(ready))
  expect(response.status).toBe(202)
  expect(response.headers.get("x-upstream")).toBe("retained")
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
  expect(stages).toEqual(["upstream-text"])
  expect((await work)._tag).toBe("Success")
})
