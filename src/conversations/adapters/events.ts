import type { AgentEventStream } from "@earendil-works/pi-durable"
import type { ChatState, ConversationFrame } from "../contracts"
import type { StreamChunk } from "@tanstack/ai/client"
import { chatMessages, messageEvents, type ChatMessage } from "../chat-messages"

type Source = {
  snapshot: () => Promise<ChatState>
  activeSession: () => string | undefined
  watch: (id: string) => Promise<AgentEventStream>
  subscribe: (listener: () => void) => () => void
}

export function conversationEvents(
  source: Source,
  signal: AbortSignal,
  tanstack = false
): Response {
  const encoder = new TextEncoder()
  let close = async (_cancelled = false) => {}
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        let closed = false,
          refreshing = false,
          dirty = false
        const isClosed = () => closed
        let watch: AgentEventStream | undefined, session: string | undefined
        let timer: ReturnType<typeof setTimeout> | undefined
        let last: ChatState | undefined
        let messages: ChatMessage[] | undefined
        const send = (frame: ConversationFrame | StreamChunk) => {
          if (isClosed()) return
          if ((controller.desiredSize ?? 0) <= 0) {
            void close()
            return
          }
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(frame)}\n\n`)
          )
        }
        const refresh = async () => {
          timer = undefined
          if (isClosed()) return
          if (refreshing) {
            dirty = true
            return
          }
          refreshing = true
          try {
            const active = source.activeSession()
            if (active !== session) {
              await watch?.stop()
              session = active
              watch = active ? await source.watch(active) : undefined
              if (isClosed()) {
                await watch?.stop()
                return
              }
              watch?.start(async () => schedule())
            }
            const state = await source.snapshot()
            if (tanstack) {
              const next = chatMessages(state.turns)
              for (const event of messageEvents(messages, next)) send(event)
              const { turns: _turns, ...meta } = state
              const { turns: _previous, ...oldMeta } = last ?? {}
              if (!last || JSON.stringify(meta) !== JSON.stringify(oldMeta))
                send({
                  type: "CUSTOM",
                  name: "durable-pi.metadata",
                  value: meta,
                })
              messages = next
            } else if (!last) send({ type: "snapshot", state })
            else {
              const before = new Map(
                last.turns.map((turn) => [turn.id, JSON.stringify(turn)])
              )
              const turns = state.turns.filter(
                (turn) => before.get(turn.id) !== JSON.stringify(turn)
              )
              const { turns: _old, ...oldMeta } = last
              const { turns: _new, ...meta } = state
              const changedMeta =
                JSON.stringify(meta) !== JSON.stringify(oldMeta)
              if (
                turns.length ||
                changedMeta ||
                state.turns.length !== last.turns.length
              )
                send({
                  type: "update",
                  turns,
                  ids: state.turns.map((turn) => turn.id),
                  ...(changedMeta ? { meta } : {}),
                })
            }
            last = state
          } catch {
            await close()
          } finally {
            refreshing = false
            if (dirty && !isClosed()) {
              dirty = false
              schedule()
            }
          }
        }
        const schedule = () => {
          if (!closed && !timer) timer = setTimeout(() => void refresh(), 80)
        }
        const unsubscribe = source.subscribe(schedule)
        const expires = setTimeout(() => void close(), 60_000)
        const heartbeat = setInterval(() => {
          if (!closed) {
            if ((controller.desiredSize ?? 0) <= 0) {
              void close()
              return
            }
            controller.enqueue(encoder.encode(": keepalive\n\n"))
            schedule()
          }
        }, 15_000)
        const abort = () => void close()
        close = async (cancelled = false) => {
          if (isClosed()) return
          closed = true
          clearTimeout(timer)
          clearInterval(heartbeat)
          clearTimeout(expires)
          unsubscribe()
          signal.removeEventListener("abort", abort)
          if (!cancelled) controller.close()
          await watch?.stop()
        }
        signal.addEventListener("abort", abort, { once: true })
        if (signal.aborted) void close()
        else void refresh()
      },
      cancel: () => close(true),
    },
    { highWaterMark: 4 }
  )
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "private, no-store",
      "X-Accel-Buffering": "no",
    },
  })
}
