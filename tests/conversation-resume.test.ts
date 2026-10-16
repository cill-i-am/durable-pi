import { Effect } from "effect"
import { afterEach, expect, it, vi } from "vitest"

import {
  ConversationCheckpoint,
  conversationEvents,
} from "../src/conversations/adapters/events"
import type { ChatState } from "../src/conversations/contracts"
import { conversationConnection } from "../src/features/conversation/connection"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it("forwards only an acknowledged cursor on reconnect and stops on fresh authorization denial", async () => {
  vi.useFakeTimers()
  const cursor = crypto.randomUUID(),
    urls: string[] = []
  vi.stubGlobal("fetch", async (url: string) => {
    urls.push(url)
    if (urls.length > 1) return new Response("Unauthorized", { status: 401 })
    return new Response(
      `data: ${JSON.stringify({ type: "CUSTOM", name: "durable-pi.cursor", value: cursor })}\n\n`,
      { headers: { "content-type": "text/event-stream" } }
    )
  })
  const controller = new AbortController()
  const stream = conversationConnection("home")
    .subscribe(controller.signal)
    [Symbol.asyncIterator]()
  expect((await stream.next()).value).toMatchObject({
    name: "durable-pi.connection",
  })
  expect((await stream.next()).value).toMatchObject({
    name: "durable-pi.cursor",
    value: cursor,
  })
  const denied = expect(stream.next()).rejects.toMatchObject({ status: 401 })
  await vi.advanceTimersByTimeAsync(250)
  await denied
  expect(
    new URL(urls[0]!, "https://app.internal").searchParams.has("after")
  ).toBe(false)
  expect(
    new URL(urls[1]!, "https://app.internal").searchParams.get("after")
  ).toBe(cursor)
  expect(urls).toHaveLength(2)
  // A new view or explicit reload receives a fresh transport, not this cursor.
  await expect(
    conversationConnection("home")
      .subscribe(controller.signal)
      [Symbol.asyncIterator]()
      .next()
  ).rejects.toMatchObject({ status: 401 })
  expect(
    new URL(urls[2]!, "https://app.internal").searchParams.has("after")
  ).toBe(false)
})

const state: ChatState = {
  model: "test",
  connected: true,
  memory: { messages: 20, summaries: 0, ready: true, notes: [] },
  turns: Array.from({ length: 20 }, (_, index) => ({
    id: `turn-${index}`,
    text: `Question ${index}`,
    answer: "Synthetic response. ".repeat(200),
    status: "done",
    error: null,
    created_at: "today",
  })),
}
function open(
  checkpoint: ConversationCheckpoint,
  after: string | null,
  current = state
) {
  return conversationEvents(
    {
      snapshot: () => Effect.succeed(current),
      activeSession: () => Effect.succeed(undefined),
      watch: async () => {
        throw new Error("unexpected watch")
      },
      subscribe: () => () => {},
    },
    new AbortController().signal,
    true,
    Effect.runPromiseExit,
    { checkpoint, after }
  ).body!.getReader()
}
async function read(reader: ReturnType<typeof open>) {
  const chunk = await reader.read()
  if (chunk.done) throw new Error("Stream ended before its checkpoint")
  const text = new TextDecoder().decode(chunk.value)
  return { bytes: chunk.value.byteLength, value: JSON.parse(text.slice(6)) }
}
it("resumes an unchanged conversation without retransmitting its messages, and fully resyncs changed or restarted state", async () => {
  const checkpoint = new ConversationCheckpoint()
  const first = open(checkpoint, null)
  const snapshot = await read(first)
  expect(snapshot.value.type).toBe("MESSAGES_SNAPSHOT")
  await read(first)
  const cursor = (await read(first)).value.value as string
  await first.cancel()
  const resumed = open(checkpoint, cursor)
  const next = await read(resumed)
  expect(next.value).toEqual({
    type: "CUSTOM",
    name: "durable-pi.cursor",
    value: cursor,
  })
  expect(next.bytes).toBeLessThan(snapshot.bytes / 100)
  await resumed.cancel()
  for (const [owner, current] of [
    [checkpoint, { ...state, turns: state.turns.slice(1) }],
    [new ConversationCheckpoint(), state],
  ] as const) {
    const changed = open(owner, cursor, current)
    expect((await read(changed)).value.type).toBe("MESSAGES_SNAPSHOT")
    await changed.cancel()
  }
})
it("an unknown or unacknowledged checkpoint always receives a full snapshot", async () => {
  const checkpoint = new ConversationCheckpoint()
  checkpoint.current(state)
  checkpoint.current({ ...state, model: "new" })
  const reader = open(checkpoint, crypto.randomUUID())
  expect((await read(reader)).value.type).toBe("MESSAGES_SNAPSHOT")
  await reader.cancel()
})

it("unchanged heartbeat reconciliation does not reserialize the checkpoint", async () => {
  vi.useFakeTimers()
  const checkpoint = new ConversationCheckpoint()
  const current = vi.spyOn(checkpoint, "current")
  const reader = open(checkpoint, null)
  await read(reader)
  await read(reader)
  await read(reader)
  await vi.advanceTimersByTimeAsync(15_080)
  const heartbeat = await reader.read()
  expect(new TextDecoder().decode(heartbeat.value)).toBe(": keepalive\n\n")
  expect(current).toHaveBeenCalledOnce()
  await reader.cancel()
})
