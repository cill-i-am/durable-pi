import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

const revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const view = Schema.Struct({ revision, enabled: Schema.Boolean })
const answer = Schema.Struct({
  revision,
  text: Schema.String.check(Schema.isMinLength(1)),
})
export type QuestionAnswer = typeof answer.Type
const context = Schema.Struct({
  view,
  answer: Schema.NullOr(answer),
  failure: Schema.UndefinedOr(Schema.Unknown),
})

/** Admits one local draft append per edit revision. It never submits a message. */
export function questionMachine(
  append: (answer: QuestionAnswer) => Effect.Effect<void, unknown>
) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: { input: view, context, events: { VIEW: view, ADD: answer } },
    actors: {
      append: createEffectLogic(({ input }: { input: QuestionAnswer }) =>
        Effect.exit(append(input))
      ),
    },
  }).createMachine({
    id: "question-draft",
    initial: "editing",
    context: ({ input }) => ({ view: input, answer: null, failure: undefined }),
    on: {
      VIEW: ({ context, event }) =>
        event.revision < context.view.revision
          ? undefined
          : {
              context: {
                ...context,
                view: Schema.decodeUnknownSync(view)(event),
              },
            },
    },
    states: {
      editing: {
        on: {
          ADD: ({ context, event }) =>
            !context.view.enabled ||
            event.revision !== context.view.revision ||
            !event.text.trim()
              ? undefined
              : {
                  target: "adding",
                  context: {
                    ...context,
                    answer: Schema.decodeUnknownSync(answer)(event),
                    failure: undefined,
                  },
                },
        },
      },
      adding: {
        invoke: {
          src: "append",
          input: ({ context }) => context.answer!,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "editing",
                  context: { ...context, failure: event.output.cause },
                }
              : { target: "added" },
        },
      },
      added: {
        always: ({ context }) =>
          context.view.revision !== context.answer?.revision
            ? { target: "editing" }
            : undefined,
      },
    },
  })
}
