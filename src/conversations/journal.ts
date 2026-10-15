import { Schema, Clock, Context, Effect } from "effect"
import {
  InvalidMemory,
  MemoryNotReady,
  MemoryStorageError,
  type MemoryError,
} from "../memory/domain"
import type { MemoryLedger } from "../memory/ledger"
import { messageArchiveText } from "../workspace/files"
import type { TimelineItem } from "./contracts"
import type { ConversationLedger } from "./ledger"
import type { ConversationObservation } from "./execution"
import { canSubmit, finishTransition } from "./domain"
import { conversationPrompt, unansweredArchives } from "./prompt"
import {
  ConversationConflict,
  conversationFailure,
  type ConversationFailure,
  type Turn,
  type TurnOutcome,
} from "./turns"

export interface ConversationMaterialization {
  readonly transactionGroup: object
  atomic: <T>(body: () => T) => T
  saveActivity: (root: string, activity: readonly TimelineItem[]) => void
  readActivity: (root: string) => readonly TimelineItem[] | undefined
}
export type ConversationJournalError = ConversationFailure | MemoryError
export class ConversationJournal extends Context.Service<
  ConversationJournal,
  {
    activity: (
      id: string
    ) => Effect.Effect<
      readonly TimelineItem[] | undefined,
      ConversationJournalError
    >
    prompt: (
      id: string,
      instructions: string
    ) => Effect.Effect<string | undefined, ConversationJournalError>
    archive: (
      id: string,
      observation: ConversationObservation
    ) => Effect.Effect<void, ConversationJournalError>
    complete: (
      root: Turn,
      outcomes: readonly TurnOutcome[],
      answer: string,
      error: string | null
    ) => Effect.Effect<boolean, ConversationJournalError>
  }
>()("durable-pi/conversations/ConversationJournal") {}

/** Atomic materialization is synchronous and shares Memory's native database.
 * No application runtime can execute inside the transaction callback. */
export function makeConversationJournal(
  conversations: ConversationLedger,
  memory: Pick<
    MemoryLedger,
    "transactionGroup" | "append" | "render" | "notes"
  >,
  storage: ConversationMaterialization
): typeof ConversationJournal.Service {
  const atomic = <T>(body: () => T) =>
    Effect.try({
      try: () => {
        if (
          conversations.transactionGroup !== storage.transactionGroup ||
          memory.transactionGroup !== storage.transactionGroup
        )
          throw new ConversationConflict({
            message:
              "Conversation and Memory must share their native transaction group.",
          })
        return storage.atomic(body)
      },
      catch: (cause) => {
        const failure = conversationFailure(cause)
        if (failure) return failure
        const knownFailure = Schema.decodeUnknownOption(
          Schema.Union([InvalidMemory, MemoryNotReady, MemoryStorageError])
        )(cause)
        if (knownFailure._tag === "Some") return knownFailure.value
        throw cause
      },
    })
  return {
    activity: Effect.fn("Conversations.readActivity")((id) =>
      atomic(() => storage.readActivity(id))
    ),
    prompt: Effect.fn("Conversations.pinPrompt")((id, instructions) =>
      atomic(() => {
        const turn = conversations.get(id)
        if (!turn) throw new Error("Conversation prompt has no admitted turn")
        if (turn.prompt !== null) return turn.prompt
        if (!canSubmit(turn)) return
        // The view deliberately precedes the new input's archive append.
        const view = memory.render()
        const entry = memory.append(
          `${turn.origin ? "event" : "user"}:${turn.id}`,
          turn.origin ? "note" : "user",
          messageArchiveText(turn.text, turn.attachments),
          turn.created_at
        )
        const prompt = conversationPrompt(
          turn,
          view,
          entry.id,
          instructions,
          memory.notes()
        )
        conversations.savePrompt(id, prompt)
        return prompt
      })
    ),
    archive: Effect.fn("Conversations.archiveObservation")(
      function* (id, observation) {
        const timestamp = new Date(yield* Clock.currentTimeMillis).toISOString()
        yield* atomic(() => {
          storage.saveActivity(id, observation.archivedActivity)
          for (const item of observation.archives)
            memory.append(
              item.source,
              item.kind,
              item.text,
              item.date ?? timestamp
            )
          for (const member of observation.consumed)
            conversations.consumed(member)
        })
      }
    ),
    complete: Effect.fn("Conversations.complete")(
      function* (root, outcomes, answer, error) {
        const timestamp = new Date(yield* Clock.currentTimeMillis).toISOString()
        return yield* atomic(() => {
          const current = conversations.get(root.id)
          if (!current)
            throw new Error("Conversation completion has no admitted turn")
          const members = conversations.members(root.id)
          if (
            !finishTransition(root, current, members, outcomes, answer, error)
          )
            return false
          for (const item of unansweredArchives(current, members, outcomes))
            memory.append(
              item.source,
              item.kind,
              item.text,
              item.date ?? timestamp
            )
          if (!conversations.finish(root, outcomes, answer, error))
            throw new Error(
              "Conversation completion changed within its native transaction"
            )
          return true
        })
      }
    ),
  }
}
