import { Effect } from "effect"

import { clocklessHandoff } from "../../src/conversations/adapters/handoff"
import { ConversationLatency } from "../../src/conversations/latency"

export const conversationHandoffProbe = Effect.fn("Test.conversationHandoff")(
  function* () {
    const latency = new ConversationLatency()
    const owned: Promise<void>[] = []
    const open = (signal = new AbortController().signal) =>
      clocklessHandoff(
        latency,
        Effect.void,
        signal,
        Effect.runPromiseExit,
        (task) => {
          owned.push(task)
        }
      )
    const first = yield* open()
    const second = yield* open()
    const third = yield* open()
    const capacityBounded = third.status === 429
    const reader = first.body!.getReader()
    const stages: string[] = []
    let text = ""
    const read = Effect.promise(async () => {
      const next = await reader.read()
      text += new TextDecoder().decode(next.value)
      stages.push(
        ...new TextDecoder()
          .decode(next.value)
          .split("\n\n")
          .filter(Boolean)
          .map((frame) => JSON.parse(frame.slice(6)).stage)
      )
    })
    while (!stages.includes("ready")) yield* read
    yield* latency.provider("turn", "attempt", "session")
    yield* latency.native("session")
    yield* latency.enqueued("turn", "attempt", "stream")
    while (!stages.includes("confirmed")) yield* read
    yield* Effect.promise(() => reader.cancel())
    yield* Effect.promise(() => second.body!.cancel())
    yield* Effect.promise(() => Promise.all(owned))
    const release1 = latency.observe(() => {})
    const release2 = latency.observe(() => {})
    const released = Boolean(release1 && release2)
    release1?.()
    release2?.()

    // No consumer: outstanding native writes must terminate without an
    // unbounded queue, and native abort must settle pending writes.
    yield* open()
    for (let i = 0; i < 40; i++)
      yield* latency.provider(`overflow-${i}`, "attempt", "session")
    yield* Effect.promise(() => Promise.all(owned))
    const release3 = latency.observe(() => {})
    const release4 = latency.observe(() => {})
    const overflowReleased = Boolean(release3 && release4)
    release3?.()
    release4?.()

    const abort = new AbortController()
    yield* open(abort.signal)
    abort.abort()
    yield* Effect.promise(() => Promise.all(owned))
    const release5 = latency.observe(() => {})
    const release6 = latency.observe(() => {})
    const abortReleased = Boolean(release5 && release6)
    release5?.()
    release6?.()
    return {
      stages,
      capacityBounded,
      released,
      overflowReleased,
      abortReleased,
      privateDataAbsent:
        !text.includes("providerAt") && !text.includes("session"),
    }
  }
)
