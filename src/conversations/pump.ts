import { Clock, Effect } from "effect"

import type { MemoryRepository } from "../memory/repository"
import { canSubmit } from "./domain"
import type {
  ConversationObservation,
  ConversationExecution,
} from "./execution"
import type { ConversationJournal } from "./journal"
import type { RecoveryView } from "./recovery"
import type { Conversations } from "./service"
import type { Turn } from "./turns"

export interface ConversationPumpHost<TError, TRequirements = never> {
  canRun: (id: string) => Effect.Effect<boolean, TError, TRequirements>
  instructions: () => Effect.Effect<string, TError, TRequirements>
  recovery: (
    id: string
  ) => Effect.Effect<RecoveryView | undefined, TError, TRequirements>
  cancelAccess: (id: string) => Effect.Effect<void, TError, TRequirements>
  awaitingAccess: () => Effect.Effect<boolean, TError, TRequirements>
  cancelPlan: (id: string) => Effect.Effect<void, TError, TRequirements>
  reconcileDelegation: (
    id: string
  ) => Effect.Effect<void, TError, TRequirements>
  wakeCompaction: () => Effect.Effect<void, TError, TRequirements>
  wakeBackup: () => Effect.Effect<void, TError, TRequirements>
  wakeBackground: () => Effect.Effect<void, TError, TRequirements>
  completed: (
    turn: Turn,
    failed: boolean,
    recovery: RecoveryView | undefined
  ) => Effect.Effect<void, TError, TRequirements>
}

/** Application ordering is independent of Pi and Lifecycle. Native execution
 * retains operation IDs; Lifecycle interprets only the next persisted wake. */
export function conversationPump<TError, TRequirements>(
  conversations: typeof Conversations.Service,
  memory: Pick<typeof MemoryRepository.Service, "watermark">,
  journal: typeof ConversationJournal.Service,
  execution: typeof ConversationExecution.Service,
  host: ConversationPumpHost<TError, TRequirements>
) {
  const current = Effect.fn("Conversations.requireCurrent")(function* (
    id: string
  ) {
    const turn = yield* conversations.get(id)
    if (!turn) throw new Error("Conversation pump lost its admitted turn")
    return turn
  })
  const retry = (delay: number) =>
    Clock.currentTimeMillis.pipe(Effect.map((now) => now + delay))
  const completeTurn = Effect.fn("Conversations.completeTurn")(function* (
    turn: Turn,
    members: readonly Turn[],
    reply: ConversationObservation | undefined
  ) {
    const outcomes =
      reply?.outcomes ??
      members.map((member) => ({
        id: member.id,
        delivery: "unanswered" as const,
      }))
    const failed = outcomes.some((outcome) => outcome.delivery === "unanswered")
    const recovery = yield* host.recovery(turn.id)
    const finished = yield* journal.complete(
      turn,
      outcomes,
      reply?.answer ?? "",
      failed
        ? recovery?.phase === "blocked"
          ? recovery.detail
          : "The model could not finish. Check the connection and try again."
        : null
    )
    if (!finished) return yield* retry(10)
    yield* host.completed(turn, failed, recovery)
    yield* host.wakeBackground()
    yield* host.cancelAccess(turn.id)
    yield* host.wakeCompaction()
    yield* host.wakeBackup()
    return yield* retry(10)
  })
  const steerQueuedMembers = Effect.fn("Conversations.steerQueuedMembers")(
    function* (turn: Turn) {
      if (turn.status === "running" && turn.session_id) {
        for (const member of yield* conversations.members(turn.id)) {
          if (member.id === turn.id || member.status !== "queued") continue
          if ((yield* current(turn.id)).status === "stopping") break
          yield* execution.steer(turn.session_id, member)
          yield* conversations.submitted(member.id, turn.session_id)
        }
      }
    }
  )
  const observeActiveTurn = Effect.fn("Conversations.observeActiveTurn")(
    function* (turn: Turn) {
      const before = JSON.stringify(yield* memory.watermark())
      yield* steerQueuedMembers(turn)
      turn = yield* current(turn.id)
      const members = yield* conversations.members(turn.id)
      if (turn.status === "stopping") {
        yield* host.cancelAccess(turn.id)
        if (turn.session_id) yield* execution.abort(turn.session_id)
        yield* host.cancelPlan(turn.id)
      }
      if (
        turn.status === "running" &&
        (yield* host.recovery(turn.id))?.phase === "blocked" &&
        turn.session_id
      )
        yield* execution.abort(turn.session_id)
      if (turn.status === "running") yield* host.reconcileDelegation(turn.id)
      const reply = turn.session_id
        ? yield* execution.observe(turn, members)
        : undefined
      if (reply) yield* journal.archive(turn.id, reply)
      if (before !== JSON.stringify(yield* memory.watermark())) {
        yield* host.wakeCompaction()
        yield* host.wakeBackup()
      }
      if (reply && !reply.settled)
        return yield* retry((yield* host.awaitingAccess()) ? 30_000 : 150)
      if ((yield* current(turn.id)).revision !== turn.revision)
        return yield* retry(10)
      return yield* completeTurn(turn, members, reply)
    }
  )
  return {
    run: Effect.fn("Conversations.pump")(function* () {
      let turn = yield* conversations.active()
      if (!turn) return
      if (!(yield* host.canRun(turn.id))) {
        yield* conversations.requestStop(turn.id)
        turn = yield* current(turn.id)
      }
      if (turn.status === "queued") yield* conversations.prepare(turn.id)
      if (turn.status === "running" || turn.status === "stopping") {
        return yield* observeActiveTurn(turn)
      }
      if (!canSubmit(yield* current(turn.id))) return yield* retry(10)
      if (!turn.prompt) {
        const prompt = yield* journal.prompt(
          turn.id,
          yield* host.instructions()
        )
        if (prompt === undefined) return yield* retry(10)
        turn = { ...turn, prompt }
      }
      if (!turn.session_id) {
        // Bind an acquired native session before honoring interruption. Pi's
        // journal still owns recovery after an isolate dies between the writes.
        const id = turn.id
        const session = yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const acquired = yield* execution.createSession()
            yield* conversations.saveSession(id, acquired)
            const saved = yield* current(id)
            if (saved.session_id === null)
              throw new Error("Conversation session binding was not committed")
            return saved.session_id
          })
        )
        turn = { ...turn, session_id: session }
      }
      if (!canSubmit(yield* current(turn.id))) return yield* retry(10)
      const session = turn.session_id
      if (session === null)
        throw new Error("Conversation submission has no bound session")
      yield* execution.configure(session, turn)
      yield* host.wakeCompaction()
      if (!canSubmit(yield* current(turn.id))) return yield* retry(10)
      if (!(yield* host.canRun(turn.id))) {
        yield* conversations.requestStop(turn.id)
        return yield* retry(10)
      }
      yield* execution.submit(session, turn)
      yield* conversations.submitted(turn.id, session)
      return yield* retry(100)
    }),
  }
}
