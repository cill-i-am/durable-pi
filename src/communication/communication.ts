import { createEffectActor, waitFor } from "@xstate/effect"
import {
  Cause,
  Clock,
  Context,
  Effect,
  Equal,
  Exit,
  Schema,
  Semaphore,
  type Scope,
} from "effect"

import { AgentId, type AgentName } from "../agents/domain"
import { fatalCause, preserveFatal } from "../shared/effect"
import { communicationAdmissionMachine } from "./admission.machine"
import { communicationCommandMachine } from "./command.machine"
import {
  RequestPayload,
  failure,
  terminal,
  CommunicationError,
} from "./contracts"
import type {
  Envelope,
  Task,
  TaskRelease,
  ControlAttempt,
  MailboxRecovery,
  Outcome,
} from "./contracts"
import { LEASE_MS } from "./contracts"
import { deliverNext } from "./delivery"
import { requireFanout } from "./domain"
import { TaskExecution } from "./execution"
import { ContinuationIdentity } from "./identity"
import { Mailbox, MailboxTransport } from "./mailbox"
import type { ContinuationAdmission } from "./mailbox"
import {
  communicationPumpMachine,
  communicationTaskAttemptMachine,
  communicationContinuationMachine,
} from "./pump.machine"

export const DelegateInput = Schema.Struct({
  to: AgentId,
  ...RequestPayload.fields,
})
export type DelegateInput = typeof DelegateInput.Type
export type Source = { turnId: string; toolId: string }
export type Contact = { id: AgentId; name: typeof AgentName.Type }
export type Host = {
  readonly transactionGroup: object
  contacts: () => Effect.Effect<readonly Contact[], CommunicationError>
  prepare: (id: AgentId) => Effect.Effect<void, CommunicationError>
  current: (
    turn: string
  ) => Effect.Effect<"active" | "done" | "cancelled", CommunicationError>
  wake: () => Effect.Effect<void, CommunicationError>
  armMailbox: () => Effect.Effect<number, CommunicationError>
  recovery?: () => Effect.Effect<MailboxRecovery | null, CommunicationError>
  reconcileQueue?: () => Effect.Effect<void, CommunicationError>
  armRecovery?: (epoch: string) => Effect.Effect<number, CommunicationError>
  retryRecovery?: (
    epoch: string,
    deadline: number
  ) => Effect.Effect<void, CommunicationError>
  prearm: () => Effect.Effect<number, CommunicationError>
  wakeConversation: () => Effect.Effect<void, CommunicationError>
  idle: () => Effect.Effect<boolean, CommunicationError>
  resume: (
    task: Task,
    operationId: string,
    discoveryDeadline: number
  ) => ReturnType<ContinuationAdmission["admit"]>
  notify: () => void
}
export class Communication extends Context.Service<
  Communication,
  Effect.Success<ReturnType<typeof makeCommunication>>
>()("durable-pi/communication/Application") {}

type ObserveCommunication = <A>(
  work: Effect.Effect<A, CommunicationError>
) => Effect.Effect<A, CommunicationError>

/** The actor host joins invocations on scope closure but drops their Exit when
 * interrupted. This observes work failures and reattaches missing cleanup only
 * after that join. It owns no lifecycle state, retry, admission or persistence. */
const joinedCommunicationWork = <A>(
  body: (
    observe: ObserveCommunication
  ) => Effect.Effect<A, CommunicationError, Scope.Scope>
) =>
  Effect.suspend(() => {
    const failures: Cause.Cause<CommunicationError>[] = []
    const observe: ObserveCommunication = (work) =>
      work.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (Exit.isFailure(exit)) failures.push(exit.cause)
          })
        )
      )
    return body(observe).pipe(
      Effect.scoped,
      Effect.onExit((exit) => {
        if (!Exit.isFailure(exit) || !Cause.hasInterrupts(exit.cause))
          return Effect.void
        const retained = [...exit.cause.reasons]
        const missing = failures.flatMap((cause) =>
          cause.reasons.filter((reason) => {
            if (
              reason._tag === "Interrupt" ||
              retained.some(
                (present) =>
                  Equal.equals(present, reason) ||
                  (present._tag === "Die" &&
                    reason._tag === "Fail" &&
                    Equal.equals(present.defect, reason))
              )
            )
              return false
            retained.push(reason)
            return true
          })
        )
        return missing.length
          ? Effect.failCause(fatalCause(Cause.fromReasons(missing)))
          : Effect.void
      })
    )
  })

export const makeCommunication = (host: Host) =>
  Effect.gen(function* () {
    const mailbox = yield* Mailbox,
      transport = yield* MailboxTransport,
      execution = yield* TaskExecution,
      continuationIdentity = yield* ContinuationIdentity
    const services = Effect.provideService(Mailbox, mailbox)
    const environment = <T, TError>(
      effect: Effect.Effect<T, TError, Mailbox | MailboxTransport>
    ) =>
      effect.pipe(services, Effect.provideService(MailboxTransport, transport))
    const discover = () => host.contacts()
    const completedReleases = new Map<string, TaskRelease>()
    const cleanupConfirmed = (task: Task) =>
      task.direction === "incoming" &&
      terminal(task) &&
      (task.stop.status === "none" || task.stop.status === "confirmed")
    const serial = yield* Semaphore.make(1)
    const reconcile = Effect.fn("communication.reconcileJoinedReleases")(
      function* (taskId?: string) {
        for (const receipt of [...completedReleases.values()]) {
          if (taskId && receipt.taskId !== taskId) continue
          yield* mailbox.releaseTask(receipt)
          completedReleases.delete(receipt.owner)
          if (cleanupConfirmed(yield* mailbox.task(receipt.taskId)))
            yield* execution.settled(receipt.taskId)
        }
      }
    )
    const delegate = Effect.fn("communication.delegate")(function* (
      raw: DelegateInput,
      source: Source
    ) {
      return yield* joinedCommunicationWork((observe) =>
        Effect.gen(function* () {
          const actor = yield* createEffectActor(
            communicationAdmissionMachine({
              prepareEnvelope: observe(
                Effect.gen(function* () {
                  const input = yield* Schema.decodeUnknownEffect(
                    DelegateInput
                  )(raw).pipe(
                    Effect.mapError(() =>
                      failure("invalid", "Invalid bot task brief.")
                    )
                  )
                  if ((yield* host.current(source.turnId)) === "cancelled")
                    return yield* Effect.fail(
                      failure(
                        "forbidden",
                        "The originating request has stopped."
                      )
                    )
                  const identity = yield* mailbox.identity()
                  if (
                    input.to === identity.bot ||
                    !(yield* discover()).some((c) => c.id === input.to)
                  )
                    return yield* Effect.fail(
                      failure(
                        "forbidden",
                        "Choose another active bot owned by this account."
                      )
                    )
                  const id = `bot:${source.turnId}:${source.toolId}`
                  const siblings = yield* mailbox.byTurn(source.turnId)
                  const previous = siblings.find((t) => t.id === id)
                  if (!previous)
                    yield* Effect.try({
                      try: () => requireFanout(siblings.length),
                      catch: (cause) => {
                        const communicationError =
                          Schema.decodeUnknownOption(CommunicationError)(cause)
                        if (communicationError._tag === "Some")
                          return communicationError.value
                        throw cause
                      },
                    })
                  const now = yield* Clock.currentTimeMillis
                  const envelope: Envelope = {
                    version: 1,
                    id,
                    taskId: id,
                    owner: identity.owner,
                    from: identity.bot,
                    to: input.to,
                    correlationId: source.turnId,
                    causationId: source.toolId,
                    createdAt: previous?.request.createdAt ?? now,
                    deadline:
                      previous?.request.deadline ?? now + 10 * 60 * 1000,
                    depth: 1,
                    payload: {
                      kind: input.kind,
                      objective: input.objective,
                      context: input.context,
                    },
                  }
                  return { envelope, replay: !!previous }
                })
              ),
              prepareRecipient: (envelope) =>
                observe(host.prepare(envelope.to)),
              arm: observe(host.armMailbox()),
              authorize: (envelope) =>
                observe(
                  Effect.gen(function* () {
                    if (
                      (yield* host.current(envelope.correlationId)) ===
                      "cancelled"
                    )
                      return yield* failure(
                        "forbidden",
                        "The originating request stopped during preparation."
                      )
                  })
                ),
              commit: (envelope, discoveryDeadline) =>
                observe(
                  Effect.gen(function* () {
                    const delivery = yield* mailbox.enqueue(
                      envelope,
                      yield* Clock.currentTimeMillis,
                      { discoveryDeadline }
                    )
                    yield* Effect.sync(host.notify)
                    return delivery
                  })
                ),
            })
          )
          const done = yield* waitFor(
            actor,
            (state) => state.status === "done"
          ).pipe(Effect.orDie)
          const delivery = yield* done.output!
          const id = delivery.envelope.taskId
          return {
            id,
            delivery: delivery.status,
            execution: (yield* mailbox.task(id)).status,
            instruction:
              "The request is saved, not yet completed. You can finish this reply; a correlated result will arrive later. Do not poll in a loop or redelegate it. Activity shows its progress.",
          }
        })
      )
    })
    const execute = (
      onAttempt: (attempt: ControlAttempt | undefined) => void
    ) =>
      Effect.suspend(() => {
        const owner = crypto.randomUUID()
        let owned: Task | undefined
        let nativeExit:
          | Exit.Exit<Outcome | undefined, CommunicationError>
          | undefined
        return Effect.gen(function* () {
          const actor = yield* createEffectActor(
            communicationTaskAttemptMachine({
              claim: Effect.gen(function* () {
                const now = yield* Clock.currentTimeMillis
                const task = yield* mailbox.claimTask(now, {
                  owner,
                  deadline: now + LEASE_MS,
                })
                if (task) {
                  owned = task
                  onAttempt({
                    taskId: task.id,
                    owner,
                    revision: task.revision,
                    phase: task.control.phase,
                  })
                }
                return task
              }),
              advance: (task) =>
                execution.advance(task).pipe(
                  preserveFatal,
                  Effect.onExit((exit) =>
                    Effect.sync(() => {
                      nativeExit = exit
                    })
                  )
                ),
            })
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
              // This finalizer runs after the actor scope has joined every native
              // operation. A failed SQL write retains this exact receipt for replay.
              const persisted = yield* Effect.exit(
                Effect.gen(function* () {
                  if (!owned) return
                  const outcome = Exit.isSuccess(exit) ? exit.value : undefined
                  const receipt: TaskRelease = {
                    taskId: owned.id,
                    owner,
                    revision: owned.revision,
                    now: yield* Clock.currentTimeMillis,
                    failed: Exit.isFailure(exit),
                    ...(outcome ? { outcome } : {}),
                    ...(outcome &&
                    (owned.control.phase === "stop" ||
                      outcome.status === "cancelled" ||
                      outcome.status === "expired")
                      ? { stop: "confirmed" as const }
                      : {}),
                  }
                  completedReleases.set(owner, receipt)
                  yield* mailbox.releaseTask(receipt)
                  completedReleases.delete(owner)
                  if (cleanupConfirmed(yield* mailbox.task(owned.id)))
                    yield* execution.settled(owned.id)
                })
              )
              const existing = Exit.isFailure(exit) ? exit.cause.reasons : []
              const missing =
                nativeExit && Exit.isFailure(nativeExit)
                  ? nativeExit.cause.reasons.filter(
                      (reason) =>
                        reason._tag !== "Interrupt" &&
                        !existing.some((prior) => Equal.equals(prior, reason))
                    )
                  : []
              if (Exit.isFailure(persisted))
                missing.push(...persisted.cause.reasons)
              if (missing.length)
                return yield* Effect.failCause(Cause.fromReasons(missing))
            })
          ),
          Effect.asVoid,
          Effect.tap(() => Effect.sync(() => onAttempt(undefined)))
        )
      })
    const continueResults = (
      onAttempt: (attempt: ControlAttempt | undefined) => void
    ) =>
      Effect.gen(function* () {
        for (const task of yield* mailbox.pending()) {
          if (
            task.direction !== "outgoing" ||
            !terminal(task) ||
            task.control.unconfirmed
          )
            continue
          const owner = crypto.randomUUID()
          let owned: Task | undefined
          const control = () => ({
            taskId: owned!.id,
            owner,
            revision: owned!.revision,
            phase: owned!.control.phase,
          })
          yield* joinedCommunicationWork((observe) =>
            Effect.gen(function* () {
              const actor = yield* createEffectActor(
                communicationContinuationMachine({
                  authority: observe(
                    host
                      .current(task.request.correlationId)
                      .pipe(
                        Effect.map(
                          (current) =>
                            current !== "cancelled" && !task.cancelRequested
                        )
                      )
                  ),
                  idle: observe(host.idle()),
                  claim: observe(
                    Effect.gen(function* () {
                      const now = yield* Clock.currentTimeMillis
                      owned = yield* mailbox.claimContinuation(task.id, now, {
                        owner,
                        deadline: now + LEASE_MS,
                      })
                      if (owned) onAttempt(control())
                      return !!owned
                    })
                  ),
                  discard: observe(mailbox.discard(task.id)),
                  prepare: observe(
                    Effect.gen(function* () {
                      const operationId = yield* continuationIdentity.derive(
                        task.id
                      )
                      const deadline = yield* host.prearm()
                      return { operationId, deadline }
                    })
                  ),
                  consume: ({ operationId, deadline }) =>
                    observe(
                      mailbox.resume(task.id, {
                        transactionGroup: host.transactionGroup,
                        control: control(),
                        operationId,
                        admit: (value) =>
                          host.resume(value, operationId, deadline),
                      })
                    ),
                  wake: observe(host.wakeConversation()),
                })
              )
              const done = yield* waitFor(
                actor,
                (state) => state.status === "done"
              ).pipe(Effect.orDie)
              return yield* done.output!
            })
          ).pipe(
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                if (!owned) return
                const receipt: TaskRelease = {
                  taskId: owned.id,
                  owner,
                  revision: owned.revision,
                  now: yield* Clock.currentTimeMillis,
                  failed: Exit.isFailure(exit),
                }
                completedReleases.set(owner, receipt)
                yield* mailbox.releaseTask(receipt)
                completedReleases.delete(owner)
              })
            ),
            Effect.tap(() => Effect.sync(() => onAttempt(undefined)))
          )
        }
      })
    const pump = (
      onAttempt: (attempt: ControlAttempt | undefined) => void = () => {}
    ) =>
      serial.withPermit(
        joinedCommunicationWork((observe) =>
          Effect.gen(function* () {
            const actor = yield* createEffectActor(
              communicationPumpMachine({
                reconcile: observe(reconcile()),
                revoke: observe(
                  Effect.gen(function* () {
                    for (const task of yield* mailbox.pending())
                      if (
                        task.direction === "outgoing" &&
                        !terminal(task) &&
                        (yield* host.current(task.request.correlationId)) ===
                          "cancelled"
                      )
                        yield* mailbox.cancel(
                          task.id,
                          yield* Clock.currentTimeMillis
                        )
                  })
                ),
                deliver: observe(
                  environment(deliverNext()).pipe(Effect.asVoid)
                ),
                execute: observe(execute(onAttempt)),
                continue: observe(continueResults(onAttempt)),
                schedule: observe(
                  Effect.gen(function* () {
                    yield* Effect.sync(host.notify)
                    const next = yield* mailbox.nextWake()
                    return next === undefined
                      ? undefined
                      : Math.max((yield* Clock.currentTimeMillis) + 1000, next)
                  })
                ),
              })
            )
            const done = yield* waitFor(
              actor,
              (state) => state.status === "done"
            ).pipe(Effect.orDie)
            return yield* done.output!
          })
        )
      )
    const command = <T>(
      kind: "cancel" | "retry",
      execute: (deadline: number) => Effect.Effect<T, CommunicationError>,
      arm: Effect.Effect<number, CommunicationError> = host.armMailbox()
    ) =>
      joinedCommunicationWork((observe) =>
        Effect.gen(function* () {
          const actor = yield* createEffectActor(
            communicationCommandMachine({
              kind,
              arm: observe(arm),
              execute: (deadline) => observe(execute(deadline)),
              wake: observe(
                host.wake().pipe(Effect.ensuring(Effect.sync(host.notify)))
              ),
            })
          )
          const done = yield* waitFor(
            actor,
            (state) => state.status === "done"
          ).pipe(Effect.orDie)
          return yield* done.output!
        })
      ).pipe(Effect.uninterruptible)
    return {
      discover,
      delegate,
      pump,
      read: () =>
        (host.reconcileQueue?.() ?? Effect.void).pipe(
          Effect.andThen(
            Effect.all({
              tasks: mailbox.tasks(),
              deliveries: mailbox.deliveries(),
              recovery: host.recovery?.() ?? Effect.succeed(null),
            })
          )
        ),
      get: (id: string) => mailbox.task(id),
      reconcile,
      cancel: (id: string) =>
        command("cancel", () =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) => mailbox.cancel(id, now))
          )
        ),
      retryMailbox: (epoch: string) =>
        command(
          "retry",
          (deadline) =>
            host.retryRecovery?.(epoch, deadline) ??
            Effect.fail(failure("storage", "Mailbox recovery is unavailable.")),
          host.armRecovery?.(epoch) ??
            Effect.fail(failure("storage", "Mailbox recovery is unavailable."))
        ),
      retry: (id: string) =>
        command("retry", (discoveryDeadline) =>
          reconcile(id).pipe(
            Effect.andThen(
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((now) =>
                  mailbox.retry(id, now, { discoveryDeadline })
                )
              )
            )
          )
        ),
    }
  })
