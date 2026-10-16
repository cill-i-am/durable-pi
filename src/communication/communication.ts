import { Clock, Context, Effect, Schema } from "effect"

import { AgentId, type AgentName } from "../agents/domain"
import { preserveFatal } from "../shared/effect"
import {
  RequestPayload,
  failure,
  terminal,
  CommunicationError,
} from "./contracts"
import type { Envelope, Task } from "./contracts"
import { deliverNext } from "./delivery"
import { requireFanout } from "./domain"
import { TaskExecution } from "./execution"
import { ContinuationIdentity } from "./identity"
import { Mailbox, MailboxTransport } from "./mailbox"
import type { ContinuationAdmission } from "./mailbox"

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
  wakeConversation: () => Effect.Effect<void, CommunicationError>
  idle: () => Effect.Effect<boolean, CommunicationError>
  resume: (
    task: Task,
    operationId: string
  ) => ReturnType<ContinuationAdmission["admit"]>
  notify: () => void
}
export class Communication extends Context.Service<
  Communication,
  Effect.Success<ReturnType<typeof makeCommunication>>
>()("durable-pi/communication/Application") {}

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
    const delegate = Effect.fn("communication.delegate")(function* (
      raw: DelegateInput,
      source: Source
    ) {
      const input = yield* Schema.decodeUnknownEffect(DelegateInput)(raw).pipe(
        Effect.mapError(() => failure("invalid", "Invalid bot task brief."))
      )
      if ((yield* host.current(source.turnId)) === "cancelled")
        return yield* Effect.fail(
          failure("forbidden", "The originating request has stopped.")
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
        deadline: previous?.request.deadline ?? now + 10 * 60 * 1000,
        depth: 1,
        payload: {
          kind: input.kind,
          objective: input.objective,
          context: input.context,
        },
      }
      yield* host.prepare(input.to)
      yield* host.wake()
      if ((yield* host.current(source.turnId)) === "cancelled")
        return yield* Effect.fail(
          failure(
            "forbidden",
            "The originating request stopped during preparation."
          )
        )
      const delivery = yield* mailbox.enqueue(
        envelope,
        yield* Clock.currentTimeMillis
      )
      yield* Effect.sync(host.notify)
      return {
        id,
        delivery: delivery.status,
        execution: (yield* mailbox.task(id)).status,
        instruction:
          "The request is saved, not yet completed. You can finish this reply; a correlated result will arrive later. Do not poll in a loop or redelegate it. Activity shows its progress.",
      }
    })
    const pump = Effect.fn("communication.pump")(function* () {
      const pending = yield* mailbox.pending()
      for (const t of pending) {
        if (
          t.direction === "outgoing" &&
          !terminal(t) &&
          (yield* host.current(t.request.correlationId)) === "cancelled"
        )
          yield* mailbox.cancel(t.id, yield* Clock.currentTimeMillis)
      }
      yield* environment(deliverNext())
      const task = yield* mailbox.claimTask(yield* Clock.currentTimeMillis)
      if (task) {
        const result = yield* execution
          .advance(task)
          .pipe(preserveFatal, Effect.result)
        if (result._tag === "Success" && result.success) {
          yield* mailbox
            .finish(
              task.id,
              task.revision,
              result.success,
              yield* Clock.currentTimeMillis
            )
            .pipe(
              preserveFatal,
              Effect.catchTag("CommunicationError", (e) =>
                ["stale", "expired"].includes(e.code)
                  ? Effect.void
                  : Effect.fail(e)
              )
            )
        }
        if (terminal(yield* mailbox.task(task.id)))
          yield* execution.settled(task.id)
      }
      const remaining = yield* mailbox.pending()
      for (const t of remaining) {
        if (t.direction !== "outgoing" || !terminal(t)) continue
        if (
          (yield* host.current(t.request.correlationId)) === "cancelled" ||
          t.cancelRequested
        ) {
          yield* mailbox.discard(t.id)
        } else if (yield* host.idle()) {
          const operation = yield* continuationIdentity.derive(t.id)
          yield* host.wakeConversation()
          yield* mailbox.resume(t.id, {
            transactionGroup: host.transactionGroup,
            operationId: operation,
            admit: (value) => host.resume(value, operation),
          })
        }
      }
      yield* Effect.sync(host.notify)
      const next = yield* mailbox.nextWake()
      return next === undefined
        ? undefined
        : Math.max((yield* Clock.currentTimeMillis) + 1000, next)
    })
    return {
      discover,
      delegate,
      pump,
      read: () =>
        Effect.all({
          tasks: mailbox.tasks(),
          deliveries: mailbox.deliveries(),
        }),
      get: (id: string) => mailbox.task(id),
      cancel: (id: string) =>
        Effect.gen(function* () {
          yield* host.wake()
          const result = yield* mailbox.cancel(
            id,
            yield* Clock.currentTimeMillis
          )
          yield* Effect.sync(host.notify)
          return result
        }),
      retry: (id: string) =>
        Effect.gen(function* () {
          yield* host.wake()
          yield* mailbox.retry(id, yield* Clock.currentTimeMillis)
          yield* Effect.sync(host.notify)
        }),
    }
  })
