import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { PiHarness } from "agents/harness/pi"
import type {
  Conversation,
  Storage,
  SnapshotEvent,
  SubmissionRecord,
} from "@earendil-works/pi-durable"
import { Cause, Effect, Layer, Schema } from "effect"
import { nativeOperation } from "../../shared/interop"
import { fatalCause } from "../../shared/effect"
import { AttachmentContent } from "../../workspace/files"
import {
  ConversationExecution,
  ConversationExecutionError,
  type ConversationObservation,
} from "../execution"
import type { Turn } from "../turns"
import {
  archiveEntries,
  originalTranscript,
  placedInputs,
  replySettled,
} from "./pi-reply"
import { displayAnswer, piTimeline } from "./pi-timeline"

export interface PiObservationHost {
  storage: () => Promise<Pick<Storage, "submissionByRequest">>
  conversation: (
    session: string
  ) => Promise<Pick<Conversation, "id" | "entries">>
  session: (session: string) => {
    events: () => Promise<{
      snapshot: SnapshotEvent
      stop: () => Promise<unknown>
    }>
  }
}

export function normalizePiObservation(
  root: Turn,
  members: readonly Turn[],
  reply: {
    snapshot: SnapshotEvent
    records: ReadonlyMap<string, SubmissionRecord>
  }
): ConversationObservation {
  const { snapshot, records } = reply
  const users = placedInputs(members, records)
  const steers = new Map([...users].filter(([, member]) => member.parent_id))
  const entryIds = new Set<number>(snapshot.entries.map((entry) => entry.id))
  const answer = displayAnswer(snapshot.entries)
  const partial =
    snapshot.generation?.message?.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n") ?? ""
  return {
    settled: replySettled(root, members, reply),
    answer,
    liveAnswer: answer + partial,
    activity: piTimeline(snapshot.entries, snapshot, steers),
    archivedActivity: piTimeline(snapshot.entries, undefined, steers),
    archives: archiveEntries(root, snapshot.entries, users),
    consumed: [...users]
      .filter(([id]) => entryIds.has(id))
      .map(([, member]) => member.id),
    outcomes: members.map((member) => ({
      id: member.id,
      delivery:
        records.get(member.id)?.status === "done" ? "answered" : "unanswered",
    })),
  }
}

/** The SDK does not cancel all reads. Join each native operation before its
 * Effect ends, and check cancellation between transcript pages. */
export const conversationNativeOperation = <T>(
  operation: string,
  body: (signal: AbortSignal) => Promise<T>
) =>
  Effect.suspend(() => {
    let failed = false,
      signal: AbortSignal | undefined
    return nativeOperation(
      (currentSignal) => {
        signal = currentSignal
        return body(currentSignal).catch((cause: unknown) => {
          failed = cause !== currentSignal.reason
          throw cause
        })
      },
      (cause) => new ConversationExecutionError({ operation, cause })
    ).pipe(
      Effect.ensuring(
        Effect.suspend(() =>
          failed && signal?.aborted
            ? Effect.logError(
                "Conversation.nativeOperationFailedAfterCancellation"
              ).pipe(Effect.annotateLogs({ operation }))
            : Effect.void
        )
      )
    )
  })

export const piConversationObserver = (
  harness: () => PiObservationHost
): Pick<typeof ConversationExecution.Service, "observe"> => ({
  observe: Effect.fn("Conversations.observePi")(function* (
    root: Turn,
    members: readonly Turn[]
  ) {
    const host = harness()
    const sessionId = root.session_id!
    const storage = yield* conversationNativeOperation("read storage", () =>
      host.storage()
    )
    const conversation = yield* conversationNativeOperation(
      "open conversation",
      () => host.conversation(sessionId)
    )
    // Acquisition and stop form one native resource operation. Interruption
    // waits for a late event stream and its stop, then skips receipt reads.
    const snapshot = yield* conversationNativeOperation(
      "capture snapshot",
      async () => {
        const stream = await host.session(sessionId).events()
        let captured: SnapshotEvent | undefined,
          failure: Cause.Cause<never> | undefined
        try {
          captured = stream.snapshot
        } catch (cause) {
          failure = Cause.die(cause)
        }
        try {
          await stream.stop()
        } catch (cause) {
          const cleanup = Cause.isCause(cause)
            ? fatalCause(cause)
            : Cause.die(cause)
          failure = failure ? Cause.combine(failure, cleanup) : cleanup
        }
        if (failure) throw failure
        if (!captured)
          throw Cause.die(new Error("Native observer omitted its snapshot"))
        return captured
      }
    )
    const records = new Map<string, SubmissionRecord>()
    for (const member of members) {
      const record = yield* conversationNativeOperation("read submission", () =>
        storage.submissionByRequest(
          conversation.id,
          member.id,
          BACKGROUND_CONTEXT
        )
      )
      if (record) records.set(member.id, record)
    }
    const entries = yield* conversationNativeOperation(
      "read original transcript",
      (signal) => originalTranscript(conversation, snapshot, signal)
    )
    return normalizePiObservation(root, members, {
      records,
      snapshot: { ...snapshot, entries },
    })
  }),
})

export const piConversationLayer = (
  harness: () => PiHarness,
  defaultModel: () => string
) =>
  Layer.succeed(ConversationExecution, {
    ...piConversationObserver(harness),
    steer: Effect.fn("Conversations.steerPi")((session: string, member: Turn) =>
      conversationNativeOperation("steer", () =>
        harness()
          .session(session)
          .steer(
            [
              {
                type: "text",
                text: member.text || "Please inspect the attached files.",
              },
              ...member.input,
            ],
            { operationId: member.id }
          )
      ).pipe(Effect.asVoid)
    ),
    abort: Effect.fn("Conversations.abortPi")((session: string) =>
      conversationNativeOperation("abort", () =>
        harness().session(session).abort()
      ).pipe(Effect.asVoid)
    ),
    createSession: Effect.fn("Conversations.createPiSession")(() =>
      conversationNativeOperation("create session", () =>
        harness().sessions.create()
      ).pipe(Effect.map((session) => session.id))
    ),
    configure: Effect.fn("Conversations.configurePi")(
      (session: string, turn: Turn) =>
        conversationNativeOperation("configure", async (signal) => {
          const conversation = await harness().conversation(session)
          signal.throwIfAborted()
          await conversation.configure(
            {
              model: {
                provider: "openai",
                modelId: turn.model ?? defaultModel(),
              },
              thinkingLevel: turn.thinking ?? "medium",
              ...(turn.origin ? { tools: [] } : {}),
            },
            BACKGROUND_CONTEXT
          )
        })
    ),
    submit: Effect.fn("Conversations.submitPi")(function* (
      session: string,
      turn: Turn
    ) {
      if (turn.prompt === null)
        throw new Error("Pi submission has no pinned prompt")
      // Historical prompt corruption remains a defect, outside native error conversion.
      const content = turn.prompt.startsWith("[")
        ? [
            ...Schema.decodeUnknownSync(Schema.Array(AttachmentContent))(
              JSON.parse(turn.prompt)
            ),
          ]
        : turn.prompt
      yield* conversationNativeOperation("submit", () =>
        harness().submit(content, { session, operationId: turn.id })
      )
    }),
  })
