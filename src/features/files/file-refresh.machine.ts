import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Deferred, Effect, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { FileInfo } from "@/workspace/files"

import { fileFailure } from "./file-types"
import { preparingFile } from "./preparation"

const reply = Schema.declare((value): value is Deferred.Deferred<void> =>
  Deferred.isDeferred(value)
)
const commitEvent = Schema.Struct({
  file: FileInfo,
  mode: Schema.Literals(["upload", "update"]),
  attach: Schema.Boolean,
  reply,
})
const context = Schema.Struct({
  failures: Schema.Int,
  dirty: Schema.Boolean,
  preparing: Schema.Boolean,
  error: Schema.String,
  waiters: Schema.Array(reply),
})

/** A read cannot replace a mutation committed while it was in flight. Refreshes
 * coalesce behind the current reader; the machine owns preparation polling. */
export function fileRefreshMachine(
  read: () => Effect.Effect<readonly FileInfo[], unknown>,
  replace: (files: readonly FileInfo[]) => void,
  apply: (commit: typeof commitEvent.Type) => void
) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context,
      events: { REFRESH: Schema.Struct({ reply }), COMMIT: commitEvent },
    },
    actors: { read: createEffectLogic(() => read()) },
    actions: {
      publish: ({ params }: { params?: unknown }) =>
        Effect.sync(() =>
          replace(Schema.decodeUnknownSync(Schema.Array(FileInfo))(params))
        ),
      commit: ({ params }: { params?: unknown }) =>
        Effect.gen(function* () {
          const value = Schema.decodeUnknownSync(commitEvent)(params)
          yield* Effect.sync(() => apply(value))
          yield* Deferred.succeed(value.reply, undefined)
        }),
      answer: ({ params }: { params?: unknown }) =>
        Effect.forEach(
          Schema.decodeUnknownSync(Schema.Array(reply))(params),
          (pending) => Deferred.succeed(pending, undefined),
          { discard: true }
        ),
    },
  }).createMachine({
    id: "file-refresh",
    initial: "loading",
    context: {
      failures: 0,
      dirty: false,
      preparing: false,
      error: "",
      waiters: [],
    },
    on: {
      REFRESH: ({ context, event }) => ({
        target: ".loading",
        context: {
          ...context,
          failures: 0,
          dirty: false,
          waiters: [...context.waiters, event.reply],
        },
      }),
      COMMIT: (args, enq) => {
        enq(args.actions.commit, { ...args, params: args.event })
        return {
          target: ".loading",
          context: {
            ...args.context,
            failures: 0,
            dirty: false,
            preparing: args.context.preparing || preparingFile(args.event.file),
            error: "",
          },
        }
      },
    },
    states: {
      loading: {
        on: {
          REFRESH: ({ context, event }) => ({
            context: {
              ...context,
              failures: 0,
              dirty: true,
              waiters: [...context.waiters, event.reply],
            },
          }),
          COMMIT: (args, enq) => {
            enq(args.actions.commit, { ...args, params: args.event })
            return {
              context: {
                ...args.context,
                failures: 0,
                dirty: true,
                preparing:
                  args.context.preparing || preparingFile(args.event.file),
                error: "",
              },
            }
          },
        },
        invoke: {
          src: "read",
          onDone: (args, enq) => {
            const { context, event } = args
            if (context.dirty)
              return {
                target: "loading",
                reenter: true,
                context: { ...context, dirty: false },
              }
            enq(args.actions.publish, { ...args, params: event.output })
            enq(args.actions.answer, { ...args, params: context.waiters })
            const preparing = event.output.some(preparingFile)
            return {
              target: preparing ? "waiting" : "idle",
              context: {
                failures: 0,
                dirty: false,
                preparing,
                error: "",
                waiters: [],
              },
            }
          },
          onError: (args, enq) => {
            const { context, event } = args
            if (context.dirty)
              return {
                target: "loading",
                reenter: true,
                context: { ...context, dirty: false },
              }
            enq(args.actions.answer, { ...args, params: context.waiters })
            return {
              target: context.preparing ? "waiting" : "idle",
              context: {
                ...context,
                failures: context.failures + 1,
                error: fileFailure(event.error, "Could not load files."),
                waiters: [],
              },
            }
          },
        },
      },
      waiting: { after: { 2000: { target: "loading" } } },
      idle: {},
    },
  })
}
