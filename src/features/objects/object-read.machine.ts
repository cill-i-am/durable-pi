import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema, type Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

/** Read replacement fences old completions without sharing mutation ownership. */
export function objectReadMachine(
  read: (path: string) => Effect.Effect<unknown, unknown, Scope.Scope>
) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        path: Schema.String,
        request: Schema.String,
        value: Schema.Unknown,
        failure: Schema.UndefinedOr(Schema.Unknown),
      }),
      events: {
        READ: Schema.Struct({ path: Schema.String, request: Schema.String }),
      },
      emitted: {
        settled: Schema.Struct({ id: Schema.String, ok: Schema.Boolean }),
      },
    },
    actors: {
      read: createEffectLogic(({ input }: { input: string }) =>
        Effect.exit(read(input))
      ),
    },
  }).createMachine({
    id: "object-read",
    initial: "idle",
    context: { path: "", request: "", value: undefined, failure: undefined },
    on: {
      READ: ({ context, event }, enq) => {
        if (context.request)
          enq.emit({ type: "settled", id: context.request, ok: false })
        return {
          target: ".reading",
          reenter: true,
          context: {
            ...context,
            path: event.path,
            request: event.request,
            failure: undefined,
          },
        }
      },
    },
    states: {
      idle: {},
      reading: {
        invoke: {
          src: "read",
          input: ({ context }) => context.path,
          onDone: ({ context, event }, enq) => {
            enq.emit({
              type: "settled",
              id: context.request,
              ok: Exit.isSuccess(event.output),
            })
            return {
              target: "idle",
              context: {
                ...context,
                request: "",
                value: Exit.isSuccess(event.output)
                  ? event.output.value
                  : context.value,
                failure: Exit.isFailure(event.output)
                  ? event.output.cause
                  : undefined,
              },
            }
          },
        },
      },
    },
  })
}
