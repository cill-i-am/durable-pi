import { Clock, Context, Effect } from "effect"

import { type MemoryError } from "../memory/domain"
import type { MemoryLedger } from "../memory/ledger"
import { messageArchiveText } from "../workspace/files"
import type { TimelineItem } from "./contracts"
import type { ConversationObservation } from "./execution"
import { canSubmitInput } from "./input.machine"
import type { ConversationLedger } from "./ledger"
import { conversationPrompt, unansweredArchives } from "./prompt"
import { completionDecision, ownsConversation } from "./root-run.machine"
import { ConversationConflict, isPending } from "./turns"
import type {
  ConversationStorageError,
  ConversationFailure,
  Turn,
  TurnOutcome,
} from "./turns"

export interface ConversationMaterialization {
  readonly transactionGroup: object
  atomic: <TValue, TError, TRequirements>(
    body: () => Effect.Effect<TValue, TError, TRequirements>
  ) => Effect.Effect<TValue, TError | ConversationStorageError, TRequirements>
  saveActivity: (
    root: string,
    activity: readonly TimelineItem[]
  ) => Effect.Effect<void, ConversationStorageError>
  readActivity: (
    root: string
  ) => Effect.Effect<
    readonly TimelineItem[] | undefined,
    ConversationStorageError
  >
  readActivities: (
    roots: readonly string[]
  ) => Effect.Effect<
    ReadonlyMap<string, readonly TimelineItem[]>,
    ConversationStorageError
  >
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
    activities: (
      ids: readonly string[]
    ) => Effect.Effect<
      ReadonlyMap<string, readonly TimelineItem[]>,
      ConversationJournalError
    >
    prompt: (
      id: string,
      instructions: string,
      owner?: string
    ) => Effect.Effect<string | undefined, ConversationJournalError>
    archive: (
      id: string,
      observation: ConversationObservation,
      owner?: string
    ) => Effect.Effect<void, ConversationJournalError>
    complete: (
      root: Turn,
      outcomes: readonly TurnOutcome[],
      answer: string,
      error: string | null,
      owner?: string
    ) => Effect.Effect<boolean, ConversationJournalError>
  }
>()("durable-pi/conversations/ConversationJournal") {}

/** Conversation, Memory and Activity share one Effect transaction owner. */
export function makeConversationJournal(
  conversations: ConversationLedger,
  memory: Pick<
    MemoryLedger,
    "transactionGroup" | "append" | "render" | "notes"
  >,
  storage: ConversationMaterialization
): typeof ConversationJournal.Service {
  const atomic = <TValue, TError, TRequirements>(
    body: () => Effect.Effect<TValue, TError, TRequirements>
  ) =>
    Effect.suspend<
      TValue,
      TError | ConversationStorageError | ConversationConflict,
      TRequirements
    >(() => {
      if (
        conversations.transactionGroup !== storage.transactionGroup ||
        memory.transactionGroup !== storage.transactionGroup
      )
        return Effect.fail(
          new ConversationConflict({
            message:
              "Conversation and Memory must share their native transaction group.",
          })
        )
      return storage.atomic(body)
    })
  return {
    activity: Effect.fn("Conversations.readActivity")((id) =>
      atomic(() => storage.readActivity(id))
    ),
    activities: Effect.fn("Conversations.readActivities")((ids) =>
      atomic(() => storage.readActivities(ids))
    ),
    prompt: Effect.fn("Conversations.pinPrompt")((id, instructions, owner) =>
      atomic(() =>
        Effect.gen(function* () {
          const turn = yield* conversations.get(id)
          if (!turn)
            return yield* Effect.die(
              new Error("Conversation prompt has no admitted turn")
            )
          const root = turn.parent_id
            ? yield* conversations.get(turn.parent_id)
            : turn
          if (
            !root ||
            !isPending(root) ||
            root.status === "stopping" ||
            !ownsConversation(root, owner)
          )
            return
          if (turn.prompt !== null) return turn.prompt
          if (!canSubmitInput(turn)) return
          const view = yield* memory.render()
          const entry = yield* memory.append(
            `${turn.origin ? "event" : "user"}:${turn.id}`,
            turn.origin ? "note" : "user",
            messageArchiveText(turn.text, turn.attachments),
            turn.created_at,
            turn.provenance
          )
          const prompt = conversationPrompt(
            turn,
            view,
            entry.id,
            instructions,
            yield* memory.notes()
          )
          yield* conversations.savePrompt(id, prompt, owner)
          return prompt
        })
      )
    ),
    archive: Effect.fn("Conversations.archiveObservation")(
      function* (id, observation, owner) {
        const timestamp = new Date(yield* Clock.currentTimeMillis).toISOString()
        yield* atomic(() =>
          Effect.gen(function* () {
            const root = yield* conversations.get(id)
            if (
              !root ||
              root.parent_id !== null ||
              !isPending(root) ||
              !ownsConversation(root, owner)
            )
              return
            yield* storage.saveActivity(id, observation.archivedActivity)
            for (const item of observation.archives)
              yield* memory.append(
                item.source,
                item.kind,
                item.text,
                item.date ?? timestamp,
                item.provenance
              )
            for (const member of observation.consumed)
              yield* conversations.consumed(member, owner)
          })
        )
      }
    ),
    complete: Effect.fn("Conversations.complete")(
      function* (root, outcomes, answer, error, owner) {
        const timestamp = new Date(yield* Clock.currentTimeMillis).toISOString()
        return yield* atomic(() =>
          Effect.gen(function* () {
            const current = yield* conversations.get(root.id)
            if (!current)
              return yield* Effect.die(
                new Error("Conversation completion has no admitted turn")
              )
            const members = yield* conversations.members(root.id)
            if (
              !completionDecision(
                root,
                current,
                members,
                outcomes,
                answer,
                error,
                owner
              )
            )
              return false
            for (const item of unansweredArchives(current, members, outcomes))
              yield* memory.append(
                item.source,
                item.kind,
                item.text,
                item.date ?? timestamp,
                item.provenance
              )
            if (
              !(yield* conversations.finish(
                root,
                outcomes,
                answer,
                error,
                owner
              ))
            )
              return yield* Effect.die(
                new Error(
                  "Conversation completion changed within its native transaction"
                )
              )
            return true
          })
        )
      }
    ),
  }
}
