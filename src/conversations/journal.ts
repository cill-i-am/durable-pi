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
export interface ConversationMemoryLease {
  readonly deadline: number
  /** Synchronous identity/availability check of the already retained wake. */
  readonly current: () => boolean
}
export interface ConversationMemoryDiscovery {
  readonly summary: ConversationMemoryLease
  readonly backup: ConversationMemoryLease
}
export interface ConversationJournalMaintenance {
  /** Arms both existing Lifecycle owners outside the native SQL transaction. */
  readonly arm: () => Effect.Effect<
    ConversationMemoryDiscovery,
    ConversationJournalError
  >
}
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
    "transactionGroup" | "hasSources" | "append" | "render" | "notes"
  >,
  storage: ConversationMaterialization,
  maintenance: ConversationJournalMaintenance
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
  const validateDiscovery = (
    discovery: ConversationMemoryDiscovery | undefined
  ) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        discovery &&
        [discovery.summary, discovery.backup].every(
          (lease) =>
            Number.isFinite(lease.deadline) &&
            lease.deadline > now &&
            lease.current()
        )
          ? Effect.void
          : Effect.fail(
              new ConversationConflict({
                message:
                  "Memory maintenance discovery expired or changed. Try again.",
              })
            )
      )
    )
  const admitSources = (
    sources: readonly string[],
    discovery: ConversationMemoryDiscovery | undefined
  ) =>
    memory
      .hasSources(sources)
      .pipe(
        Effect.flatMap((present) =>
          present ? Effect.void : validateDiscovery(discovery)
        )
      )
  const promptSource = (turn: Turn) =>
    `${turn.origin ? "event" : "user"}:${turn.id}`
  const promptTurn = (id: string, owner?: string) =>
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
      return turn.prompt !== null || canSubmitInput(turn) ? turn : undefined
    })
  const archiveRoot = (id: string, owner?: string) =>
    conversations
      .get(id)
      .pipe(
        Effect.map((root) =>
          root &&
          root.parent_id === null &&
          isPending(root) &&
          ownsConversation(root, owner)
            ? root
            : undefined
        )
      )
  const completion = (
    root: Turn,
    outcomes: readonly TurnOutcome[],
    answer: string,
    error: string | null,
    owner?: string
  ) =>
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
        return
      return unansweredArchives(current, members, outcomes)
    })
  return {
    activity: Effect.fn("Conversations.readActivity")((id) =>
      atomic(() => storage.readActivity(id))
    ),
    activities: Effect.fn("Conversations.readActivities")((ids) =>
      atomic(() => storage.readActivities(ids))
    ),
    prompt: Effect.fn("Conversations.pinPrompt")(
      function* (id, instructions, owner) {
        const pending = yield* atomic(() =>
          Effect.gen(function* () {
            const turn = yield* promptTurn(id, owner)
            if (!turn) return
            return {
              turn,
              present:
                turn.prompt !== null ||
                (yield* memory.hasSources([promptSource(turn)])),
            }
          })
        )
        if (!pending || pending.turn.prompt !== null)
          return pending?.turn.prompt ?? undefined
        const discovery = pending.present ? undefined : yield* maintenance.arm()
        return yield* atomic(() =>
          Effect.gen(function* () {
            const turn = yield* promptTurn(id, owner)
            if (!turn || turn.prompt !== null) return turn?.prompt ?? undefined
            // Coordinator acquisition may have outlived or replaced either wake.
            yield* admitSources([promptSource(turn)], discovery)
            const view = yield* memory.render()
            const entry = yield* memory.append(
              promptSource(turn),
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
      }
    ),
    archive: Effect.fn("Conversations.archiveObservation")(
      function* (id, observation, owner) {
        const sources = observation.archives.map((item) => item.source)
        const pending = yield* atomic(() =>
          Effect.gen(function* () {
            if (!(yield* archiveRoot(id, owner))) return
            return { present: yield* memory.hasSources(sources) }
          })
        )
        if (!pending) return
        const discovery = pending.present ? undefined : yield* maintenance.arm()
        yield* atomic(() =>
          Effect.gen(function* () {
            if (!(yield* archiveRoot(id, owner))) return
            yield* admitSources(sources, discovery)
            const timestamp = new Date(
              yield* Clock.currentTimeMillis
            ).toISOString()
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
        const pending = yield* atomic(() =>
          Effect.gen(function* () {
            const archives = yield* completion(
              root,
              outcomes,
              answer,
              error,
              owner
            )
            if (!archives) return
            return {
              present: yield* memory.hasSources(
                archives.map((item) => item.source)
              ),
            }
          })
        )
        if (!pending) return false
        // Answered/empty completion still releases native cleanup when a
        // maintenance owner requires explicit recovery; it adds no Memory work.
        const discovery = pending.present ? undefined : yield* maintenance.arm()
        return yield* atomic(() =>
          Effect.gen(function* () {
            const archives = yield* completion(
              root,
              outcomes,
              answer,
              error,
              owner
            )
            if (!archives) return false
            yield* admitSources(
              archives.map((item) => item.source),
              discovery
            )
            const timestamp = new Date(
              yield* Clock.currentTimeMillis
            ).toISOString()
            for (const item of archives)
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
