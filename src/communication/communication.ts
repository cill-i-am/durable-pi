import { Clock, Context, Effect, Schema } from "effect"
import { AgentId, type AgentName } from "../agents/domain"
import { Mailbox, MailboxTransport } from "./mailbox"
import { RequestPayload, failure, terminal } from "./contracts"
import type { CommunicationError, Envelope, Task } from "./contracts"
import { deliverNext } from "./delivery"
import type { piMailbox } from "./adapters/pi"

export const DelegateInput = Schema.Struct({
  to: AgentId,
  ...RequestPayload.fields,
})
export type DelegateInput = typeof DelegateInput.Type
export type Source = { turnId: string; toolId: string }
export type Contact = { id: AgentId; name: typeof AgentName.Type }
export type Host = {
  contacts: () => Effect.Effect<readonly Contact[], CommunicationError>
  prepare: (id: AgentId) => Effect.Effect<void, CommunicationError>
  current: (turn: string) => "active" | "done" | "cancelled"
  wake: () => Effect.Effect<void, CommunicationError>
  wakeConversation: () => Effect.Effect<void, CommunicationError>
  idle: () => boolean
  resume: (task: Task, operationId: string) => void
  notify: () => void
}
export class Communication extends Context.Service<
  Communication,
  Effect.Success<ReturnType<typeof makeCommunication>>
>()("durable-pi/communication/Application") {}

export const makeCommunication = (
  host: Host,
  pi: ReturnType<typeof piMailbox>
) =>
  Effect.gen(function* () {
    const mailbox = yield* Mailbox,
      transport = yield* MailboxTransport
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
      if (host.current(source.turnId) === "cancelled")
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
      if (!previous && siblings.length >= 3)
        return yield* Effect.fail(
          failure(
            "limit",
            "This request already delegated its three permitted tasks."
          )
        )
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
      if (host.current(source.turnId) === "cancelled")
        return yield* Effect.fail(
          failure(
            "forbidden",
            "The originating request stopped during preparation."
          )
        )
      // There must be no foreign await between the durable wake and local admission.
      const delivery = yield* mailbox.enqueue(envelope, now)
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
          host.current(t.request.correlationId) === "cancelled"
        )
          yield* mailbox.cancel(t.id, yield* Clock.currentTimeMillis)
      }
      yield* environment(deliverNext())
      const task = yield* mailbox.claimTask(yield* Clock.currentTimeMillis)
      if (task) {
        const result = yield* pi.advance(task).pipe(Effect.result)
        if (result._tag === "Success" && result.success) {
          yield* mailbox
            .finish(
              task.id,
              task.revision,
              result.success,
              yield* Clock.currentTimeMillis
            )
            .pipe(
              Effect.catchTag("CommunicationError", (e) =>
                ["stale", "expired"].includes(e.code)
                  ? Effect.void
                  : Effect.fail(e)
              )
            )
        }
        if (terminal(yield* mailbox.task(task.id))) yield* pi.settled(task.id)
        // Transient native failures retain the leased execution. Deadline and request
        // budgets bound recovery; we never resubmit a different Pi operation identity.
      }
      const remaining = yield* mailbox.pending()
      for (const t of remaining) {
        if (t.direction !== "outgoing" || !terminal(t)) continue
        if (
          host.current(t.request.correlationId) === "cancelled" ||
          t.cancelRequested
        ) {
          yield* mailbox.resume(t.id, () => {})
        } else if (host.idle()) {
          const operation = yield* continuationId(t.id)
          yield* host.wakeConversation()
          yield* mailbox.resume(t.id, (value) => host.resume(value, operation))
        }
      }
      yield* Effect.sync(host.notify)
      const next = yield* mailbox.nextWake()
      // Never hold a model call open. Waiting results, approvals or active user turns
      // cause no extra model attempts. Lifecycle owns this persisted wake.
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

/** Stable UUID means a crash cannot create a second continuation turn. */
export const continuationId = (id: string) =>
  Effect.tryPromise({
    try: async () => {
      const hash = new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(`communication-result:${id}`)
        )
      )
      hash[6] = (hash[6]! & 15) | 64
      hash[8] = (hash[8]! & 63) | 128
      const text = Array.from(hash.slice(0, 16), (n) =>
        n.toString(16).padStart(2, "0")
      ).join("")
      return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`
    },
    catch: () => failure("storage", "Could not derive continuation identity."),
  })
