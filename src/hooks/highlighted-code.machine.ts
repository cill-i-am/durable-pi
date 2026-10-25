import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import type { loadHighlighter } from "@/lib/highlighter"

export type LoadedHighlighter = Awaited<ReturnType<typeof loadHighlighter>>
const input = Schema.Struct({ language: Schema.String })
const highlighter = Schema.declare(
  (value): value is LoadedHighlighter =>
    value === null ||
    (typeof value === "object" &&
      "highlight" in value &&
      typeof value.highlight === "function")
)
const context = Schema.Struct({
  language: Schema.String,
  highlighter,
  failure: Schema.UndefinedOr(Schema.Unknown),
})

/** The hook owns a language-load observation; Shiki's shared cache is not disposed by a borrower. */
export function highlightedCodeMachine(
  load: (language: string) => Effect.Effect<LoadedHighlighter, unknown>
) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: { input, context, events: { LANGUAGE: input } },
    actors: {
      load: createEffectLogic(({ input }: { input: string }) =>
        Effect.exit(load(input))
      ),
    },
  }).createMachine({
    id: "highlighted-code",
    initial: "loading",
    context: ({ input }) => ({
      language: input.language,
      highlighter: null,
      failure: undefined,
    }),
    on: {
      LANGUAGE: ({ context, event }) =>
        event.language === context.language
          ? undefined
          : {
              target: ".loading",
              reenter: true,
              context: {
                language: event.language,
                highlighter: null,
                failure: undefined,
              },
            },
    },
    states: {
      loading: {
        invoke: {
          src: "load",
          input: ({ context }) => context.language,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "failed",
                  context: { ...context, failure: event.output.cause },
                }
              : {
                  target: event.output.value ? "ready" : "unsupported",
                  context: { ...context, highlighter: event.output.value },
                },
        },
      },
      ready: {},
      unsupported: {},
      failed: {},
    },
  })
}
