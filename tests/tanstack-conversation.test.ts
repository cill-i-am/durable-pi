import { afterEach, describe, expect, it, vi } from "vitest"
import { ChatClient, StreamProcessor } from "@tanstack/ai-client"
import { EventType } from "@tanstack/ai/client"
import {
  chatMessages,
  conversationView,
  messageEvents,
} from "../src/conversations/chat-messages"
import { conversationEvents } from "../src/conversations/adapters/events"
import { conversationConnection } from "../src/features/conversation/connection"
import { submissionAttempt } from "../src/features/conversation/commands"
import type { ChatState } from "../src/conversations/contracts"

const metadata = {
  model: "test",
  connected: true,
  memory: { messages: 0, summaries: 0, ready: true, notes: [] },
}
const base: ChatState["turns"][number] = {
  id: "turn-one",
  text: "Make a checklist",
  answer: "",
  status: "running",
  error: null,
  created_at: "2026-10-12T00:00:00Z",
}
const text = (value: string) => ({
  id: "assistant:0:0",
  type: "text" as const,
  text: value,
})
const projection = (processor: StreamProcessor) =>
  conversationView(processor.getMessages(), metadata)
const clients: ChatClient[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function fixture(initial: ChatState = { ...metadata, turns: [base] }) {
  let state = initial
  const listeners = new Set<() => void>()
  const requests: { method: string; url: string; body?: string }[] = []
  let denied = false
  const fetcher = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        method: init?.method ?? "GET",
        url: String(url),
        body: init?.body as string | undefined,
      })
      if (denied) return new Response("Unauthorized", { status: 401 })
      if (init?.method === "POST") return Response.json({ ok: true })
      return conversationEvents(
        {
          snapshot: async () => state,
          activeSession: () => undefined,
          watch: async () => {
            throw new Error("not needed")
          },
          subscribe: (listener) => {
            listeners.add(listener)
            return () => {
              listeners.delete(listener)
            }
          },
        },
        init?.signal ?? new AbortController().signal,
        true
      )
    }
  )
  vi.stubGlobal("fetch", fetcher)
  return {
    requests,
    listeners,
    fetcher,
    deny: () => {
      denied = true
    },
    change: (next: ChatState) => {
      state = next
      for (const listener of listeners) listener()
    },
    client: (bot = "a") => {
      let meta: Omit<ChatState, "turns"> | undefined
      const client = new ChatClient({
        threadId: bot,
        connection: conversationConnection(bot),
        onCustomEvent(name, value) {
          if (name === "durable-pi.metadata") meta = value as typeof meta
        },
      })
      clients.push(client)
      client.subscribe()
      return {
        client,
        view: () =>
          meta ? conversationView(client.getMessages(), meta) : null,
      }
    },
  }
}
const flush = async (ms = 100) => {
  await vi.advanceTimersByTimeAsync(ms)
}

describe("Pi records through the real TanStack processor", () => {
  it("retains the separately bounded copyable answer and pending approvals", () => {
    const processor = new StreamProcessor()
    const turn = {
      ...base,
      answer: "Full saved response",
      activity: [text("Display shortened")],
    }
    messageEvents(undefined, chatMessages([turn])).forEach((event) =>
      processor.processChunk(event)
    )
    const access = {
      tools: [],
      approvals: [
        {
          id: "approval",
          turnId: base.id,
          tool: "read",
          input: "{}",
          createdAt: 1,
          expiresAt: 2,
          status: "pending" as const,
          revision: 0,
        },
      ],
    }
    const view = conversationView(processor.getMessages(), {
      ...metadata,
      access,
    })
    expect(view.turns).toEqual([turn])
    expect(view.access).toEqual(access)
  })
  it("hydrates text, reasoning, tools, steering and terminal state without executing them", () => {
    const activity = [
      { id: "thought", type: "thinking" as const, text: "Checking the notes" },
      {
        id: "tool",
        type: "tool" as const,
        name: "create_checklist",
        input: '{"title":"Project"}',
        output: '{"id":"object-1"}',
        status: "done" as const,
      },
      { id: "steer:correction", type: "steer" as const, text: "Use Friday" },
      text("Done"),
    ]
    const turn = {
      ...base,
      status: "done" as const,
      answer: "Done",
      activity,
      steering: [
        { id: "correction", text: "Use Friday", delivery: "answered" as const },
      ],
    }
    const processor = new StreamProcessor()
    for (const event of messageEvents(undefined, chatMessages([turn])))
      processor.processChunk(event)
    expect(projection(processor).turns).toEqual([turn])
    const call = processor
      .getMessages()
      .flatMap((m) => m.parts)
      .find((p) => p.type === "tool-call")
    expect(call?.id).toBe("turn-one:tool")
    expect(call?.output).toEqual({ id: "object-1" })
  })
  it("sends only incremental text while streaming, then repairs from an authoritative snapshot", () => {
    const processor = new StreamProcessor()
    let previous = chatMessages([
      { ...base, answer: "Hello", activity: [text("Hello")] },
    ])
    messageEvents(undefined, previous).forEach((event) =>
      processor.processChunk(event)
    )
    for (const answer of ["Hello world", "Hello world!"]) {
      const next = chatMessages([{ ...base, answer, activity: [text(answer)] }])
      const events = messageEvents(previous, next)
      expect(events).toHaveLength(1)
      expect(events[0]?.type).toBe(EventType.TEXT_MESSAGE_CONTENT)
      events.forEach((event) => processor.processChunk(event))
      expect(projection(processor).turns[0]?.answer).toBe(answer)
      previous = next
    }
    const restored = chatMessages([
      {
        ...base,
        status: "cancelled",
        answer: "Hello world!",
        activity: [text("Hello world!")],
      },
    ])
    messageEvents(undefined, restored).forEach((event) =>
      processor.processChunk(event)
    )
    expect(projection(processor).turns).toHaveLength(1)
    expect(projection(processor).turns[0]?.status).toBe("cancelled")
    expect(projection(processor).turns[0]?.answer).toBe("Hello world!")
  })
  it("handles new segments, replaced content, missing turns and colliding tool IDs across turns", () => {
    const tool = {
      id: "call",
      type: "tool" as const,
      name: "read",
      input: "{}",
      output: "one",
      status: "done" as const,
    }
    const processor = new StreamProcessor()
    const previous = chatMessages([
      {
        ...base,
        activity: [
          text("before"),
          tool,
          { id: "later", type: "text", text: "after" },
        ],
      },
      { ...base, id: "two", activity: [{ ...tool, output: "two" }] },
    ])
    messageEvents(undefined, previous).forEach((event) =>
      processor.processChunk(event)
    )
    expect(projection(processor).turns[1]?.activity?.[0]).toMatchObject({
      output: "two",
    })
    const next = chatMessages([
      { ...base, answer: "replacement", activity: [text("replacement")] },
    ])
    messageEvents(previous, next).forEach((event) =>
      processor.processChunk(event)
    )
    expect(projection(processor).turns).toHaveLength(1)
    expect(projection(processor).turns[0]?.answer).toBe("replacement")
    expect(JSON.stringify(next)).not.toContain("signature")
  })
})

describe("TanStack live connection against the production SSE adapter", () => {
  it("rejoins saved work after disconnect, observes cancellation, and never resends a prompt", async () => {
    vi.useFakeTimers()
    const f = fixture({
      ...metadata,
      turns: [{ ...base, answer: "Hello", activity: [text("Hello")] }],
    })
    const first = f.client()
    await flush()
    expect(first.view()?.turns[0]?.answer).toBe("Hello")
    f.change({
      ...metadata,
      turns: [
        { ...base, answer: "Hello again", activity: [text("Hello again")] },
      ],
    })
    await flush()
    expect(first.view()?.turns[0]?.answer).toBe("Hello again")
    first.client.dispose()
    await flush()
    expect(f.listeners.size).toBe(0)
    f.change({
      ...metadata,
      turns: [
        {
          ...base,
          status: "cancelled",
          answer: "Hello again",
          activity: [text("Hello again")],
        },
      ],
    })
    const second = f.client()
    await flush()
    expect(second.view()?.turns).toHaveLength(1)
    expect(second.view()?.turns[0]?.status).toBe("cancelled")
    expect(f.requests.every((request) => request.method === "GET")).toBe(true)
  })
  it("reauthorizes a rotated connection and stops retrying a revoked session", async () => {
    vi.useFakeTimers()
    const f = fixture()
    const { client } = f.client()
    await flush()
    f.deny()
    await flush(60_300)
    expect(client.getError()?.message).toContain("session has expired")
    const count = f.requests.length
    await flush(30_000)
    expect(f.requests).toHaveLength(count)
    expect(f.listeners.size).toBe(0)
  })
  it("recovers from transient fetch failure and bounds persistent failures", async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.fetcher.mockRejectedValueOnce(new TypeError("offline"))
    const good = f.client()
    await flush(600)
    expect(good.view()?.turns[0]?.id).toBe(base.id)
    good.client.dispose()
    f.fetcher.mockRejectedValue(new TypeError("offline"))
    const start = f.requests.length
    const bad = f.client()
    await flush(20_000)
    expect(bad.client.getError()?.message).toBe(
      "Could not reconnect. Reconnect to try again."
    )
    // Mock rejection occurs before the fixture records a request.
    expect(f.requests.length).toBe(start)
    const calls = f.fetcher.mock.calls.length
    await flush(20_000)
    expect(f.fetcher).toHaveBeenCalledTimes(calls)
  })
  it("bounds empty streams rather than silently reconnecting forever", async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.fetcher.mockImplementation(
      async () =>
        new Response("", { headers: { "Content-Type": "text/event-stream" } })
    )
    const { client } = f.client()
    await flush(20_000)
    expect(f.fetcher).toHaveBeenCalledTimes(5)
    expect(client.getError()?.message).toContain("Could not reconnect")
  })
  it("keeps bot subscriptions separate and rejects SDK-generated submissions without durable intent", async () => {
    vi.useFakeTimers()
    const f = fixture()
    const a = f.client("a")
    await flush()
    a.client.dispose()
    f.change({ ...metadata, turns: [] })
    const b = f.client("b")
    await flush()
    expect(b.view()?.turns).toEqual([])
    expect(f.requests.at(-1)?.url).toContain("agent=b")
    const connection = conversationConnection("b")
    await expect(connection.send([], {})).rejects.toThrow()
    expect(f.requests.every((request) => request.method === "GET")).toBe(true)
    const first = submissionAttempt(null, "Use Friday", "steer")
    await connection.send([], first)
    await connection.send(
      [],
      submissionAttempt(first, "Use Friday", "followUp")
    )
    const posts = f.requests.filter((request) => request.method === "POST")
    expect(posts).toHaveLength(2)
    expect(posts[0]?.body).toBe(posts[1]?.body)
    expect(JSON.parse(posts[0]!.body!)).toEqual(first)
  })
})
