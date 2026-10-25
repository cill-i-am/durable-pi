import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Deferred, Effect, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import type { FileInfo } from "@/workspace/files"

import { fileFailure } from "./file-types"

const reply = Schema.declare((value): value is Deferred.Deferred<boolean> =>
  Deferred.isDeferred(value)
)
const request = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  action: Schema.Literals(["trash", "restore", "rename", "extract"]),
  name: Schema.UndefinedOr(Schema.String),
  reply,
})
export type FileMutation = typeof request.Type

export function fileMutationMachine(
  mutate: (request: FileMutation) => Effect.Effect<FileInfo, unknown>,
  publish: (file: FileInfo) => Effect.Effect<void>
) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        request: Schema.NullOr(request),
        error: Schema.String,
      }),
      events: { MUTATE: request, CLEAR_ERROR: Schema.Struct({}) },
    },
    actors: {
      mutate: createEffectLogic(({ input }: { input: FileMutation }) =>
        mutate(input).pipe(Effect.tap(publish))
      ),
    },
    actions: {
      answer: ({ params }: { params?: unknown }) => {
        const value = Schema.decodeUnknownSync(
          Schema.Struct({ reply, accepted: Schema.Boolean })
        )(params)
        return Deferred.succeed(value.reply, value.accepted)
      },
    },
  }).createMachine({
    id: "file-mutation",
    initial: "idle",
    context: { request: null, error: "" },
    on: {
      CLEAR_ERROR: ({ context }) => ({ context: { ...context, error: "" } }),
      MUTATE: (args, enq) => {
        enq(args.actions.answer, {
          ...args,
          params: { reply: args.event.reply, accepted: false },
        })
      },
    },
    states: {
      idle: {
        on: {
          MUTATE: ({ event }) => ({
            target: "updating",
            context: { request: event, error: "" },
          }),
        },
      },
      updating: {
        invoke: {
          src: "mutate",
          input: ({ context }) => context.request!,
          onDone: (args, enq) => {
            enq(args.actions.answer, {
              ...args,
              params: { reply: args.context.request!.reply, accepted: true },
            })
            return { target: "idle", context: { request: null, error: "" } }
          },
          onError: (args, enq) => {
            enq(args.actions.answer, {
              ...args,
              params: { reply: args.context.request!.reply, accepted: false },
            })
            return {
              target: "idle",
              context: {
                request: null,
                error: fileFailure(
                  args.event.error,
                  "Could not update this file."
                ),
              },
            }
          },
        },
      },
    },
  })
}
