import { Effect } from "effect"

import {
  ConversationCheckpoint,
  conversationEvents,
} from "../../src/conversations/adapters/events"
import type { ChatState } from "../../src/conversations/contracts"
import { ConversationLatency } from "../../src/conversations/latency"

/** Leave the native body unread across publication. The former four-frame
 * queue accepted the marker/start and then closed before the first text. */
export const conversationStreamProbe = Effect.fn("Test.conversationStream")(
  function* (milestones = false) {
    const turn = {
      id: "turn",
      text: "question",
      answer: "",
      status: "running" as const,
      error: null,
      created_at: "2026-10-21",
    }
    let state: ChatState = {
      turns: [turn],
      model: "test",
      connected: true,
      memory: { messages: 0, summaries: 0, ready: true, notes: [] },
    }
    let notify = () => {}
    let released = 0
    const latency = new ConversationLatency()
    const response = conversationEvents(
      {
        latency,
        milestones,
        snapshot: () => Effect.sync(() => state),
        activeSession: () => Effect.succeed(undefined),
        watch: async () => {
          throw new Error("unused")
        },
        subscribe: (listener) => {
          notify = listener
          return () => released++
        },
      },
      new AbortController().signal,
      true,
      Effect.runPromiseExit,
      { checkpoint: new ConversationCheckpoint(), after: null }
    )
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => response.body!.getReader()),
      (reader) =>
        Effect.gen(function* () {
          // Let the initial snapshot fill the native queue without consuming it.
          yield* Effect.sleep(10)
          yield* latency.provider("turn", "attempt", "session")
          yield* latency.native("session")
          state = {
            ...state,
            turns: [{ ...turn, answer: "Native first text" }],
          }
          notify()
          yield* Effect.sleep(10)
          let received = ""
          for (;;) {
            const next = yield* Effect.promise(() => reader.read())
            if (next.done) break
            received += new TextDecoder().decode(next.value)
            if (received.includes('"type":"TEXT_MESSAGE_CONTENT"')) break
          }
          return {
            delivered: received.includes('"delta":"Native first text"'),
            cursorFrames: received.match(/durable-pi.cursor/g)?.length ?? 0,
            handoffFrames: received.match(/durable-pi.handoff/g)?.length ?? 0,
          }
        }),
      (reader) => Effect.promise(() => reader.cancel())
    ).pipe(Effect.map((result) => ({ ...result, released })))
  }
)
