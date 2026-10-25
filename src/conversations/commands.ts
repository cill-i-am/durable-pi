import { createEffectActor, waitFor } from "@xstate/effect"
import { Cause, Effect, Equal, Exit, Ref, Schema } from "effect"

import type { SubmissionReceipt } from "./admission"
import {
  conversationCommandMachine,
  type ConversationCommandKind,
} from "./command.machine"
import type { ConversationError, Conversations } from "./service"
import { ConversationConflict, type Submission } from "./turns"

export class ConversationNotFound extends Schema.TaggedError<ConversationNotFound>()(
  "ConversationNotFound",
  {}
) {}

export const retryMessage = <TError, TRequirements>(
  conversations: Pick<typeof Conversations.Service, "get">,
  admit: (
    input: Submission
  ) => Effect.Effect<SubmissionReceipt, TError, TRequirements>
) =>
  Effect.fn("Conversations.retryMessage")(function* (input: {
    operationId: string
    turnId: string
  }) {
    const source = yield* conversations.get(input.turnId)
    if (!source) return yield* new ConversationNotFound()
    return yield* admit({
      operationId: input.operationId,
      text: source.text,
      files: source.attachments.map((file) => file.id),
      retryOf: source.id,
    })
  })

interface ConversationCommandHost<E, R> {
  prearm: () => Effect.Effect<number, E, R>
  wake: () => Effect.Effect<void, E, R>
  wakeBackground: () => Effect.Effect<void, E, R>
  notify: () => Effect.Effect<void, E, R>
}

function runCommand<E, R>(work: {
  kind: ConversationCommandKind
  arm: Effect.Effect<number, E, R>
  execute: (
    lease: Exit.Exit<number, E> | undefined
  ) => Effect.Effect<void, E, R>
}) {
  return Effect.gen(function* () {
    const failed = yield* Ref.make<Cause.Cause<E> | undefined>(undefined)
    const observe = <A>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? Ref.update(failed, (old) =>
                old ? Cause.combine(old, exit.cause) : exit.cause
              )
            : Effect.void
        )
      )
    return yield* Effect.gen(function* () {
      const actor = yield* createEffectActor(
        conversationCommandMachine({
          ...work,
          arm: observe(work.arm),
          execute: (lease) =>
            observe(Effect.suspend(() => work.execute(lease))),
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
          if (!Exit.isFailure(exit) || !Cause.hasInterrupts(exit.cause)) return
          const failure = yield* Ref.get(failed)
          const reasons =
            failure?.reasons.filter(
              (reason) =>
                reason._tag !== "Interrupt" &&
                !exit.cause.reasons.some((present) =>
                  Equal.equals(present, reason)
                )
            ) ?? []
          if (reasons.length)
            return yield* Effect.failCause(Cause.fromReasons(reasons))
        })
      )
    )
  })
}

const notifyCommand = <E, R>(host: ConversationCommandHost<E, R>) =>
  Effect.gen(function* () {
    // Each doorbell is useful independently after the durable decision. Preserve
    // every failure while still giving the other owners their notification.
    const outcomes = [
      yield* Effect.exit(Effect.suspend(host.wake)),
      yield* Effect.exit(Effect.suspend(host.wakeBackground)),
      yield* Effect.exit(Effect.suspend(host.notify)),
    ]
    const reasons = outcomes.flatMap((exit) =>
      Exit.isFailure(exit) ? exit.cause.reasons : []
    )
    if (reasons.length)
      return yield* Effect.failCause(Cause.fromReasons(reasons))
  })

export const stopConversation = <E, R, StopError>(
  conversations: {
    requestStop: (
      ...args: Parameters<(typeof Conversations.Service)["requestStop"]>
    ) => Effect.Effect<unknown, StopError, R>
  },
  host: ConversationCommandHost<E, R>
) =>
  Effect.fn("Conversations.stop")((id: string) =>
    // Local cancellation must not abandon the revocation after a failed or
    // interrupted discovery attempt. The host bounds this small control call.
    Effect.uninterruptible(
      runCommand<E | StopError, R>({
        kind: "stop",
        arm: Effect.suspend(host.prearm),
        execute: (lease) =>
          Effect.gen(function* () {
            yield* conversations.requestStop(
              id,
              lease && Exit.isSuccess(lease)
                ? { discoveryDeadline: lease.value }
                : {
                    unconfirmedError:
                      "Stop was saved, but recovery could not be scheduled. Check the reply or try Stop again.",
                  }
            )
            yield* notifyCommand(host)
          }),
      })
    )
  )

export const retryConversationStop = <E, R>(
  conversations: Pick<typeof Conversations.Service, "retryStop">,
  host: ConversationCommandHost<E, R>
) =>
  Effect.fn("Conversations.retryStop")((id: string, expectedRevision: number) =>
    runCommand<E | ConversationError, R>({
      kind: "retryStop",
      arm: Effect.suspend(host.prearm),
      execute: (lease) =>
        Effect.gen(function* () {
          if (!lease || Exit.isFailure(lease))
            return yield* Effect.die(
              "Retry Stop requires an armed discovery lease"
            )
          if (
            !(yield* conversations.retryStop(id, expectedRevision, lease.value))
          )
            return yield* new ConversationConflict({
              message:
                "This reply changed or its previous control operation is still finishing. Refresh before trying Stop again.",
            })
          yield* notifyCommand(host)
        }),
    })
  )

export const checkConversationReply = <E, R>(host: {
  inspect: (
    id: string,
    expectedRevision: number
  ) => Effect.Effect<unknown, E, R>
  notify: () => Effect.Effect<void, E, R>
}) =>
  Effect.fn("Conversations.checkReply")(
    (id: string, expectedRevision: number) =>
      runCommand({
        kind: "inspect",
        arm: Effect.die("Reply inspection cannot arm discovery"),
        execute: () =>
          Effect.gen(function* () {
            yield* host.inspect(id, expectedRevision)
            yield* host.notify()
          }),
      })
  )
