import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema, type Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

/** The browser adapter owns the context and each tone's shorter resource scope. */
export interface InteractionSoundSession {
  readonly state: () => string
  readonly resume: Effect.Effect<void, unknown>
  readonly play: Effect.Effect<void, unknown, Scope.Scope>
}

export interface InteractionSoundCapabilities {
  readonly enabled: () => boolean
  readonly acquire: Effect.Effect<InteractionSoundSession | null, unknown>
}

const outcome = Schema.declare((value): value is Exit.Exit<void, unknown> =>
  Exit.isExit(value)
)
const session = Schema.declare(
  (value): value is InteractionSoundSession =>
    typeof value === "object" && value !== null && "resume" in value
)

/** One activation. Independent actors preserve overlapping clicks without a queue. */
export function interactionSoundMachine(sound: InteractionSoundCapabilities) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      events: { PLAY: Schema.Struct({ preview: Schema.Boolean }) },
      context: Schema.Struct({
        preview: Schema.Boolean,
        session: Schema.NullOr(session),
        outcome: Schema.UndefinedOr(outcome),
      }),
    },
    actors: {
      acquire: createEffectLogic(Effect.exit(sound.acquire)),
      resume: createEffectLogic(
        ({ input }: { input: InteractionSoundSession }) =>
          Effect.exit(input.resume)
      ),
      play: createEffectLogic(({ input }: { input: InteractionSoundSession }) =>
        Effect.exit(input.play.pipe(Effect.scoped))
      ),
    },
  }).createMachine({
    id: "interaction-sound",
    initial: "idle",
    context: () => ({
      preview: false,
      session: null as InteractionSoundSession | null,
      outcome: undefined as Exit.Exit<void, unknown> | undefined,
    }),
    states: {
      idle: {
        on: {
          PLAY: ({ context, event }) => ({
            target:
              event.preview || sound.enabled() ? "acquiring" : "suppressed",
            context: { ...context, preview: event.preview },
          }),
        },
      },
      acquiring: {
        invoke: {
          src: "acquire",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: { ...context, outcome: event.output },
                }
              : {
                  target: "acquired",
                  context: { ...context, session: event.output.value },
                },
        },
      },
      acquired: {
        always: ({ context }) => ({
          target:
            context.session?.state() === "suspended" ? "resuming" : "checking",
        }),
      },
      resuming: {
        invoke: {
          src: "resume",
          input: ({ context }) => context.session!,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: { ...context, outcome: event.output },
                }
              : { target: "checking" },
        },
      },
      checking: {
        always: ({ context }) => ({
          target:
            context.session?.state() === "running" &&
            (context.preview || sound.enabled())
              ? "playing"
              : "suppressed",
        }),
      },
      playing: {
        invoke: {
          src: "play",
          input: ({ context }) => context.session!,
          onDone: ({ context, event }) => ({
            target: "settled",
            context: { ...context, outcome: event.output },
          }),
        },
      },
      suppressed: { type: "final" },
      settled: { type: "final" },
    },
  })
}
