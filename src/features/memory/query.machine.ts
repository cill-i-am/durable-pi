import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema, type Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

export const MemoryTreePart = Schema.Struct({
  start: Schema.Number,
  count: Schema.Number,
  text: Schema.String,
})
export type MemoryTreePart = typeof MemoryTreePart.Type
export const MemoryOriginal = Schema.Struct({
  kind: Schema.String,
  text: Schema.String,
  date: Schema.String,
})
export const MemoryBranch = Schema.Struct({
  children: Schema.Array(MemoryTreePart),
  original: Schema.NullOr(MemoryOriginal),
})
export const MemoryMatches = Schema.Array(
  Schema.Struct({
    id: Schema.Number,
    text: Schema.String,
    kind: Schema.String,
    date: Schema.String,
  })
)
export const MemoryQuery = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("search"), query: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("source"), source: Schema.Number }),
  Schema.Struct({
    kind: Schema.Literal("tree"),
    trail: Schema.Array(MemoryTreePart),
    initial: Schema.Boolean,
  }),
])
export type MemoryQuery = typeof MemoryQuery.Type
export const MemoryQueryData = Schema.Struct({
  results: MemoryMatches,
  parts: Schema.Array(MemoryTreePart),
  original: Schema.NullOr(MemoryOriginal),
  trail: Schema.Array(MemoryTreePart),
})
export type MemoryQueryData = typeof MemoryQueryData.Type
export type MemoryQueryWork = (
  request: MemoryQuery
) => Effect.Effect<MemoryQueryData, unknown, Scope.Scope>

const capture = (request: MemoryQuery | null): MemoryQuery | null =>
  request?.kind === "tree"
    ? { ...request, trail: request.trail.map((part) => ({ ...part })) }
    : request && { ...request }

const failed = (request: MemoryQuery) =>
  request.kind === "search"
    ? "Could not search memory. Try again."
    : request.kind === "source"
      ? "Could not load the source message."
      : request.initial
        ? "Could not load memory."
        : "This part of memory is not ready yet. Try again shortly."

/** A selection owns one read at a time. Only explicit retry/open admits more work. */
export function memoryQueryMachine(read: MemoryQueryWork) {
  const open = ({
    context,
    event,
  }: {
    context: {
      request: MemoryQuery | null
      data: MemoryQueryData | null
      error: string
    }
    event: { trail: readonly MemoryTreePart[] }
  }) =>
    context.request?.kind === "tree"
      ? {
          target: "loading",
          context: {
            ...context,
            request: capture({
              kind: "tree",
              trail: event.trail,
              initial: false,
            }),
            error: "",
          },
        }
      : undefined
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input: Schema.NullOr(MemoryQuery),
      context: Schema.Struct({
        request: Schema.NullOr(MemoryQuery),
        data: Schema.NullOr(MemoryQueryData),
        error: Schema.String,
      }),
      events: {
        RETRY: Schema.Struct({}),
        OPEN: Schema.Struct({ trail: Schema.Array(MemoryTreePart) }),
      },
    },
    actors: {
      read: createEffectLogic({
        schemas: { input: MemoryQuery },
        effect: ({ input }) => Effect.exit(read(input)),
      }),
    },
  }).createMachine({
    id: "memory-query",
    initial: "selecting",
    context: ({ input }) => ({
      request: capture(input),
      data: null,
      error: "",
    }),
    states: {
      selecting: {
        always: ({ context }) => ({
          target: context.request ? "loading" : "inactive",
        }),
      },
      inactive: {},
      loading: {
        invoke: {
          src: "read",
          input: ({ context }) => context.request!,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "failed",
                  context: { ...context, error: failed(context.request!) },
                }
              : context.request?.kind === "source" &&
                  !event.output.value.original
                ? {
                    target: "failed",
                    context: {
                      ...context,
                      error: "This source message is unavailable.",
                    },
                  }
                : {
                    target: "ready",
                    context: {
                      ...context,
                      data: event.output.value,
                      error: "",
                    },
                  },
        },
      },
      ready: { on: { OPEN: open } },
      failed: {
        on: {
          OPEN: open,
          RETRY: ({ context }) => ({
            target: "loading",
            context: { ...context, error: "" },
          }),
        },
      },
    },
  })
}
