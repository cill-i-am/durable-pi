import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Clock, Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { observeCleanup } from "../shared/effect"
import { ReplyDraft } from "./contracts"
import type { ReplyPreparation } from "./preparation"

/** Shared email/WhatsApp progression; channel capabilities supply formatting,
 * native conversation admission, authority and the existing durable stores. */
export function replyPreparationMachine<E>(
  work: ReplyPreparation<E>,
  observeFailure: <A>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>
) {
  const observe = <A>(effect: Effect.Effect<A, E>) =>
    observeFailure(
      Effect.gen(function* () {
        const remaining = work.deadline - (yield* Clock.currentTimeMillis)
        if (remaining <= 0) return yield* Effect.fail(work.timeout)
        // Every stage, including delivery preparation, consumes the same lease.
        // Timeout joins owned cleanup before the machine can settle this pass.
        return yield* observeCleanup(effect, (observed) =>
          observed.pipe(
            Effect.timeoutOrElse({
              duration: remaining,
              orElse: () => Effect.fail(work.timeout),
            })
          )
        )
      })
    )
  const outcome = Schema.declare((value): value is Exit.Exit<void, E> =>
    Exit.isExit(value)
  )
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        kind: Schema.Literals([
          "control",
          "media",
          "admit",
          "deliver",
          "observe",
          "skip",
        ]),
        draft: ReplyDraft,
        ready: Schema.Boolean,
        mediaRevision: Schema.Number,
        mediaError: Schema.String,
        control: Schema.Boolean,
        outcome,
      }),
      output: outcome,
    },
    actors: {
      check: createEffectLogic(Effect.exit(observe(work.check))),
      cancel: createEffectLogic(Effect.exit(observe(work.cancel))),
      expire: createEffectLogic(
        Effect.exit(
          observe(work.expire ?? Effect.die("Channel has no reply window"))
        )
      ),
      control: createEffectLogic(Effect.exit(observe(work.control))),
      claimMedia: createEffectLogic(
        Effect.exit(
          observe(
            work.media?.claim ?? Effect.die("Channel has no media admission")
          )
        )
      ),
      importMedia: createEffectLogic(
        Effect.exit(
          observe(
            work.media?.import ?? Effect.die("Channel has no media admission")
          )
        )
      ),
      saveMedia: createEffectLogic(
        ({ input }: { input: { revision: number; fileId: string } }) =>
          Effect.exit(
            observe(
              Effect.suspend(
                () =>
                  work.media?.save(input.revision, input.fileId) ??
                  Effect.die("Channel has no media admission")
              )
            )
          )
      ),
      failMedia: createEffectLogic(
        ({ input }: { input: { revision: number; error: string } }) =>
          Effect.exit(
            observe(
              Effect.suspend(
                () =>
                  work.media?.fail(input.revision, input.error) ??
                  Effect.die("Channel has no media admission")
              )
            )
          )
      ),
      admit: createEffectLogic(({ input }: { input: readonly string[] }) =>
        Effect.exit(observe(Effect.suspend(() => work.admit(input))))
      ),
      prepared: createEffectLogic(
        ({ input }: { input: { reply: string; control: boolean } }) =>
          Effect.exit(
            observe(
              Effect.suspend(() => work.prepared(input.reply, input.control))
            )
          )
      ),
      read: createEffectLogic(Effect.exit(observe(work.observe))),
      notify: createEffectLogic(Effect.exit(observe(work.notify))),
      deliver: createEffectLogic(({ input }: { input: ReplyDraft }) =>
        Effect.exit(observe(Effect.suspend(() => work.deliver(input))))
      ),
    },
  }).createMachine({
    id: "reply-preparation",
    context: () => ({
      kind: work.kind,
      draft: work.draft,
      ready: false,
      mediaRevision: 0,
      mediaError: "",
      control: false,
      outcome: Exit.void as Exit.Exit<void, E>,
    }),
    output: ({ context }) => context.outcome,
    initial: "checking",
    states: {
      checking: {
        invoke: {
          src: "check",
          onDone: ({ context, event }) => {
            if (Exit.isFailure(event.output))
              return {
                target: "settled",
                context: {
                  ...context,
                  outcome: Exit.failCause(event.output.cause),
                },
              }
            if (event.output.value === "cancelled")
              return { target: "cancelling" }
            if (event.output.value === "expired") return { target: "expiring" }
            const target = {
              control: "controlling",
              media: "claimingMedia",
              admit: "admitting",
              deliver: "delivering",
              observe: "observing",
              skip: "settled",
            }[context.kind]
            return { target }
          },
        },
      },
      controlling: {
        invoke: {
          src: "control",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : {
                  target: "savingPreparation",
                  context: {
                    ...context,
                    control: true,
                    draft: { ...context.draft, text: event.output.value },
                  },
                },
        },
      },
      claimingMedia: {
        invoke: {
          src: "claimMedia",
          onDone: ({ context, event }) => {
            if (Exit.isFailure(event.output))
              return {
                target: "settled",
                context: {
                  ...context,
                  outcome: Exit.failCause(event.output.cause),
                },
              }
            if (event.output.value === undefined) return { target: "settled" }
            return {
              target: "importingMedia",
              context: { ...context, mediaRevision: event.output.value },
            }
          },
        },
      },
      importingMedia: {
        invoke: {
          src: "importMedia",
          onDone: ({ context, event }) => {
            if (Exit.isFailure(event.output))
              return {
                target: "settled",
                context: {
                  ...context,
                  outcome: Exit.failCause(event.output.cause),
                },
              }
            return "rejected" in event.output.value
              ? {
                  target: "failingMedia",
                  context: {
                    ...context,
                    mediaError: event.output.value.rejected,
                  },
                }
              : {
                  target: "savingMedia",
                  context: {
                    ...context,
                    draft: {
                      ...context.draft,
                      files: [event.output.value.fileId],
                    },
                  },
                }
          },
        },
      },
      savingMedia: {
        invoke: {
          src: "saveMedia",
          input: ({ context }) => ({
            revision: context.mediaRevision,
            fileId: context.draft.files[0]!,
          }),
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : { target: event.output.value ? "admitting" : "settled" },
        },
      },
      admitting: {
        invoke: {
          src: "admit",
          input: ({ context }) => context.draft.files,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : { target: "savingPreparation" },
        },
      },
      observing: {
        invoke: {
          src: "read",
          onDone: ({ context, event }) => {
            if (Exit.isFailure(event.output))
              return {
                target: "settled",
                context: {
                  ...context,
                  outcome: Exit.failCause(event.output.cause),
                },
              }
            const { draft, ready, notify } = event.output.value
            return {
              target: notify ? "notifying" : ready ? "delivering" : "settled",
              context: { ...context, draft, ready },
            }
          },
        },
      },
      notifying: {
        invoke: {
          src: "notify",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : { target: context.ready ? "delivering" : "settled" },
        },
      },
      cancelling: {
        invoke: {
          src: "cancel",
          onDone: ({ context, event }) => ({
            target: "settled",
            context: {
              ...context,
              outcome: Exit.isFailure(event.output)
                ? Exit.failCause(event.output.cause)
                : Exit.void,
            },
          }),
        },
      },
      expiring: {
        invoke: {
          src: "expire",
          onDone: ({ context, event }) => ({
            target: "settled",
            context: {
              ...context,
              outcome: Exit.isFailure(event.output)
                ? Exit.failCause(event.output.cause)
                : Exit.void,
            },
          }),
        },
      },
      failingMedia: {
        invoke: {
          src: "failMedia",
          input: ({ context }) => ({
            revision: context.mediaRevision,
            error: context.mediaError,
          }),
          onDone: ({ context, event }) => ({
            target: "settled",
            context: {
              ...context,
              outcome: Exit.isFailure(event.output)
                ? Exit.failCause(event.output.cause)
                : Exit.void,
            },
          }),
        },
      },
      savingPreparation: {
        invoke: {
          src: "prepared",
          input: ({ context }) => ({
            reply: context.control ? context.draft.text : "",
            control: context.control,
          }),
          onDone: ({ context, event }) => ({
            target: "settled",
            context: {
              ...context,
              outcome: Exit.isFailure(event.output)
                ? Exit.failCause(event.output.cause)
                : Exit.void,
            },
          }),
        },
      },
      delivering: {
        invoke: {
          src: "deliver",
          input: ({ context }) => context.draft,
          onDone: ({ context, event }) => ({
            target: "settled",
            context: {
              ...context,
              outcome: Exit.isFailure(event.output)
                ? Exit.failCause(event.output.cause)
                : Exit.void,
            },
          }),
        },
      },
      settled: { type: "final" },
    },
  })
}
