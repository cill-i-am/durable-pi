import { createEffectActor, waitFor } from "@xstate/effect"
import { Cause, Clock, Effect, Equal, Exit } from "effect"

import type { MemoryError } from "../memory/domain"
import type { MemoryRepository } from "../memory/repository"
import { observeCleanup } from "../shared/effect"
import type { AttachmentReadiness } from "./attachments"
import {
  ConversationControlTimeout,
  ConversationExecutionError,
  type ConversationExecution,
} from "./execution"
import type { ConversationJournal, ConversationJournalError } from "./journal"
import {
  conversationPumpMachine,
  pumpTurn,
  type ConversationControlMode,
  type ConversationControlPhase,
  type ConversationPumpContext,
  type ConversationPumpWork,
} from "./pump.machine"
import type { RecoveryView } from "./recovery"
import type { Conversations } from "./service"
import { ConversationConflict, type ControlRelease, type Turn } from "./turns"

export interface ConversationPumpHost<TError, TRequirements = never> {
  prepareRuntime?: (turn: Turn) => Effect.Effect<void, TError, TRequirements>
  prepareFiles?: (
    turn: Turn,
    owner: string
  ) => Effect.Effect<AttachmentReadiness, TError, TRequirements>
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
export interface ConversationControlAttempt {
  rootId: string
  revision: number
  phase: ConversationControlPhase
}
export { ConversationControlTimeout } from "./execution"
/** This is a control/transport budget, never a deadline for Pi's run or approval. */
export const conversationControlPassMs = 60_000

export function conversationPump<TError, TRequirements>(
  conversations: typeof Conversations.Service,
  memory: Pick<typeof MemoryRepository.Service, "watermark">,
  journal: typeof ConversationJournal.Service,
  execution: typeof ConversationExecution.Service,
  host: ConversationPumpHost<TError, TRequirements>
) {
  type E =
    | TError
    | ConversationJournalError
    | MemoryError
    | ConversationExecutionError
    | ConversationControlTimeout
  type C = ConversationPumpContext<E>
  // These receipts exist only after this host has joined the actor's native
  // cleanup. They permit exact release retries, never takeover of live work.
  const completedReleases = new Map<
    string,
    {
      rootId: string
      owner: string
      confirmed: boolean
      result: ControlRelease
    }
  >()
  const reconcile = Effect.fn("Conversations.reconcileCompletedControl")(
    function* () {
      for (const receipt of [...completedReleases.values()]) {
        yield* conversations.releaseControl(
          receipt.rootId,
          receipt.owner,
          receipt.confirmed,
          receipt.result
        )
        completedReleases.delete(receipt.owner)
      }
    }
  )
  return {
    reconcile,
    run: Effect.fn("Conversations.pump")(function* (
      mode: ConversationControlMode = "automatic",
      target?: { id: string; revision: number },
      onAttempt?: (attempt: ConversationControlAttempt) => void
    ) {
      yield* reconcile()
      const services = yield* Effect.context<TRequirements>()
      const owner = crypto.randomUUID()
      const deadline =
        (yield* Clock.currentTimeMillis) + conversationControlPassMs
      let owned: Turn | undefined
      let phase: ConversationControlPhase = "handoff"
      const failures: Cause.Cause<E>[] = []
      let confirmed = false
      let timedOut = false
      const remember = (turn: Turn) => {
        owned = turn
        // A first Stop is an independent control intent. A late handoff read
        // may discover it, but only an actual Stop operation can own its retry
        // receipt; keep the preceding receipt correlated to the old revision.
        if (turn.status !== "stopping" || phase === "stop")
          onAttempt?.({ rootId: turn.id, revision: turn.revision, phase })
        return turn
      }
      const current = (id: string) =>
        conversations.get(id).pipe(
          Effect.map((turn) => {
            if (!turn)
              throw new Error("Conversation pump lost its admitted turn")
            return remember(turn)
          })
        )
      const supply = <A>(effect: Effect.Effect<A, E, TRequirements>) =>
        Effect.provideContext(effect, services)
      const keep = (c: C, effect: Effect.Effect<unknown, E, TRequirements>) =>
        supply(effect).pipe(Effect.as(c))
      const native = <A>(
        next: ConversationControlPhase,
        effect: Effect.Effect<A, E>
      ) =>
        Effect.suspend(() => {
          phase = next
          if (owned) remember(owned)
          return effect
        })
      const observe = <A>(effect: Effect.Effect<A, E>) =>
        Effect.gen(function* () {
          const remaining = deadline - (yield* Clock.currentTimeMillis)
          const timeout = () => {
            timedOut = true
            return Effect.fail(new ConversationControlTimeout({ phase }))
          }
          if (remaining <= 0) return yield* timeout()
          return yield* observeCleanup(
            effect.pipe(
              Effect.onExit((exit) =>
                Effect.sync(() => {
                  if (Exit.isFailure(exit)) failures.push(exit.cause)
                })
              )
            ),
            (observed) =>
              observed.pipe(
                Effect.timeoutOrElse({ duration: remaining, orElse: timeout })
              )
          )
        }).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (Exit.isFailure(exit)) failures.push(exit.cause)
            })
          )
        )
      const work: ConversationPumpWork<E> = {
        prepareRuntime: (c) =>
          keep(c, host.prepareRuntime?.(pumpTurn(c)) ?? Effect.void),
        claim: (c) =>
          Effect.gen(function* () {
            const active = yield* conversations.active()
            if (!active || (target && target.id !== active.id)) {
              if (target)
                return yield* new ConversationConflict({
                  message:
                    "The reply changed. Refresh it before checking again.",
                })
              return c
            }
            const turn = yield* conversations.claimControl(
              active.id,
              owner,
              deadline,
              mode,
              target?.revision
            )
            if (!turn) {
              if (target)
                return yield* new ConversationConflict({
                  message:
                    "The reply changed or is still busy. Refresh it before checking again.",
                })
              return c
            }
            remember(turn)
            phase =
              turn.status === "stopping"
                ? "stop"
                : turn.status === "running"
                  ? "observe"
                  : "handoff"
            remember(turn)
            return { ...c, turn, reconcileHandoff: turn.session_id !== null }
          }),
        check: (c) =>
          Effect.gen(function* () {
            const turn = pumpTurn(c)
            const allowed = yield* supply(host.canRun(turn.id))
            const fresh = yield* current(turn.id)
            return {
              ...c,
              allowed,
              ready: fresh.revision === turn.revision,
              turn: fresh,
            }
          }),
        requestStop: (c) =>
          Effect.gen(function* () {
            yield* conversations.requestStop(pumpTurn(c).id)
            return { ...c, turn: yield* current(pumpTurn(c).id) }
          }),
        members: (c) =>
          conversations
            .members(pumpTurn(c).id)
            .pipe(Effect.map((members) => ({ ...c, members }))),
        prepareFile: (c) =>
          supply(
            host.prepareFiles?.(c.members[c.index]!, owner) ??
              Effect.succeed<AttachmentReadiness>({ ready: true })
          ).pipe(
            Effect.map((readiness) => ({
              ...c,
              ready: readiness.ready,
              preparationError: readiness.error,
            }))
          ),
        refresh: (c) =>
          current(pumpTurn(c).id).pipe(Effect.map((turn) => ({ ...c, turn }))),
        prepareRoot: (c) =>
          Effect.gen(function* () {
            yield* conversations.prepare(pumpTurn(c).id, owner)
            return { ...c, turn: yield* current(pumpTurn(c).id) }
          }),
        prompt: (c) =>
          Effect.gen(function* () {
            const turn = pumpTurn(c)
            if (turn.prompt !== null) return c
            yield* journal.prompt(
              turn.id,
              yield* supply(host.instructions()),
              owner
            )
            return { ...c, turn: yield* current(turn.id) }
          }),
        session: (c) =>
          Effect.gen(function* () {
            const turn = pumpTurn(c)
            if (turn.session_id !== null) return c
            // Acquisition and durable binding are inseparable local ownership.
            // A late session is bound before this scope may release its root.
            const saved = yield* Effect.uninterruptible(
              Effect.gen(function* () {
                const session = yield* native(
                  "handoff",
                  execution.createSession()
                )
                yield* conversations.saveSession(turn.id, session, owner)
                const saved = yield* current(turn.id)
                if (saved.session_id === null)
                  throw new Error(
                    "Conversation session binding was not committed"
                  )
                return saved
              })
            )
            return { ...c, turn: saved, reconcileHandoff: false }
          }),
        configure: (c) =>
          keep(
            c,
            native(
              "handoff",
              execution.configure(pumpTurn(c).session_id!, pumpTurn(c))
            )
          ),
        wakeCompaction: (c) => keep(c, host.wakeCompaction()),
        submit: (c) =>
          keep(
            c,
            native(
              "handoff",
              execution.submit(pumpTurn(c).session_id!, pumpTurn(c))
            )
          ),
        submitted: (c) =>
          Effect.gen(function* () {
            const turn = pumpTurn(c)
            yield* conversations.submitted(turn.id, turn.session_id!, owner)
            return { ...c, turn: yield* current(turn.id) }
          }),
        watermark: (c) =>
          memory.watermark().pipe(
            Effect.map((watermark) => ({
              ...c,
              before: JSON.stringify(watermark),
            }))
          ),
        steer: (c) =>
          keep(
            c,
            native(
              "handoff",
              execution.steer(pumpTurn(c).session_id!, c.members[c.index]!)
            )
          ),
        steered: (c) =>
          Effect.gen(function* () {
            yield* conversations.submitted(
              c.members[c.index]!.id,
              pumpTurn(c).session_id!,
              owner
            )
            return { ...c, turn: yield* current(pumpTurn(c).id) }
          }),
        recovery: (c) =>
          supply(host.recovery(pumpTurn(c).id)).pipe(
            Effect.map((recovery) => ({ ...c, recovery }))
          ),
        cancelAccess: (c) => keep(c, host.cancelAccess(pumpTurn(c).id)),
        abort: (c) =>
          Effect.gen(function* () {
            if (pumpTurn(c).session_id)
              yield* native("stop", execution.abort(pumpTurn(c).session_id!))
            return c
          }),
        cancelPlan: (c) => keep(c, host.cancelPlan(pumpTurn(c).id)),
        delegation: (c) => keep(c, host.reconcileDelegation(pumpTurn(c).id)),
        observe: (c) =>
          Effect.gen(function* () {
            const turn = pumpTurn(c)
            const members = yield* conversations.members(turn.id)
            const reply = turn.session_id
              ? yield* native(
                  phase === "stop" ? "stop" : "observe",
                  execution.observe(turn, members)
                )
              : undefined
            return { ...c, members, reply }
          }),
        archive: (c) =>
          c.reply
            ? keep(c, journal.archive(pumpTurn(c).id, c.reply, owner))
            : Effect.succeed(c),
        memoryChanged: (c) =>
          memory.watermark().pipe(
            Effect.map((watermark) => ({
              ...c,
              ready: c.before !== JSON.stringify(watermark),
            }))
          ),
        wakeBackup: (c) => keep(c, host.wakeBackup()),
        awaitingAccess: (c) =>
          supply(host.awaitingAccess()).pipe(
            Effect.map((ready) => ({ ...c, ready }))
          ),
        complete: (c) =>
          Effect.gen(function* () {
            const turn = pumpTurn(c)
            const outcomes = c.preparationError
              ? c.members.map((member) => ({
                  id: member.id,
                  delivery: "unanswered" as const,
                }))
              : (c.reply?.outcomes ??
                c.members.map((member) => ({
                  id: member.id,
                  delivery: "unanswered" as const,
                })))
            const failed = outcomes.some(
              (outcome) => outcome.delivery === "unanswered"
            )
            const ready = yield* journal.complete(
              turn,
              outcomes,
              c.preparationError ? "" : (c.reply?.answer ?? ""),
              c.preparationError ??
                (failed
                  ? c.recovery?.phase === "blocked"
                    ? c.recovery.detail
                    : "The model could not finish. Check the connection and try again."
                  : null),
              owner
            )
            if (ready) confirmed = true
            return { ...c, ready }
          }),
        completed: (c) =>
          keep(
            c,
            host.completed(
              pumpTurn(c),
              !!c.preparationError ||
                (
                  c.reply?.outcomes ??
                  c.members.map((member) => ({
                    id: member.id,
                    delivery: "unanswered",
                  }))
                ).some((outcome) => outcome.delivery === "unanswered"),
              c.recovery
            )
          ),
        wakeBackground: (c) => keep(c, host.wakeBackground()),
        schedule: (c) =>
          Clock.currentTimeMillis.pipe(
            Effect.map((now) => ({
              ...c,
              outcome: Exit.succeed(
                c.wake === undefined ? undefined : now + c.wake
              ),
            }))
          ),
      }
      return yield* Effect.gen(function* () {
        const actor = yield* createEffectActor(
          conversationPumpMachine(work, mode, observe)
        )
        const done = yield* waitFor(
          actor,
          (state) => state.status === "done"
        ).pipe(Effect.orDie)
        return yield* done.output!
      }).pipe(
        Effect.scoped,
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            // Actor scope closure above has joined every acquired resource and
            // native operation. Only now may a later same-session owner proceed.
            const finalization = yield* Effect.exit(
              Effect.gen(function* () {
                if (!owned) return
                remember(owned)
                const receipt = {
                  rootId: owned.id,
                  owner,
                  confirmed,
                  result: {
                    failed: Exit.isFailure(exit),
                    phase,
                    timedOut,
                    inspected: mode === "inspect",
                    error: timedOut
                      ? "Reply control could not be confirmed before its deadline. Check the reply or retry Stop."
                      : "Reply control could not be confirmed after several attempts. Check the reply or retry Stop.",
                  },
                }
                completedReleases.set(owner, receipt)
                yield* conversations.releaseControl(
                  receipt.rootId,
                  owner,
                  confirmed,
                  receipt.result
                )
                completedReleases.delete(owner)
              })
            )
            const retained: Cause.Reason<E>[] = [
              ...(Exit.isFailure(exit) ? exit.cause.reasons : []),
              ...(Exit.isFailure(finalization)
                ? finalization.cause.reasons
                : []),
            ]
            const additions: Cause.Reason<E>[] = []
            for (const reason of failures.flatMap(
              (failure) => failure.reasons
            )) {
              if (reason._tag === "Interrupt") continue
              const present = retained.some((existing) => {
                const candidate =
                  existing._tag === "Die" &&
                  reason._tag === "Fail" &&
                  Cause.isReason(existing.defect) &&
                  Cause.isFailReason(existing.defect)
                    ? existing.defect
                    : existing
                const same =
                  candidate._tag === "Fail" && reason._tag === "Fail"
                    ? Equal.equals(candidate.error, reason.error)
                    : candidate._tag === "Die" && reason._tag === "Die"
                      ? Equal.equals(candidate.defect, reason.defect)
                      : false
                return (
                  same &&
                  [...reason.annotations].every(
                    ([key, value]) =>
                      candidate.annotations.has(key) &&
                      Equal.equals(candidate.annotations.get(key), value)
                  )
                )
              })
              if (!present) {
                additions.push(reason)
                retained.push(reason)
              }
            }
            const reasons = [
              ...(Exit.isFailure(finalization)
                ? finalization.cause.reasons
                : []),
              ...additions,
            ]
            if (reasons.length)
              return yield* Effect.failCause(Cause.fromReasons(reasons))
          })
        )
      )
    }),
  }
}
