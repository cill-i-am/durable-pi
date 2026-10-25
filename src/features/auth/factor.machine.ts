import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Redacted, Schema, type Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { Secret, authMessage } from "./auth-contracts"

const Action = Schema.Literals(["enable", "disable", "codes", "verify"])
export type FactorAction = typeof Action.Type
const Enrollment = Schema.Struct({
  uri: Schema.String,
  codes: Schema.Array(Schema.String),
})
const Material = Schema.Redacted(Enrollment, { disallowJsonEncode: true })
export type FactorMaterial = typeof Material.Type
const Request = Schema.Struct({ action: Action, secret: Secret })
export type FactorRequest = typeof Request.Type
export type FactorWork = {
  request: (
    input: FactorRequest
  ) => Effect.Effect<FactorMaterial | null, unknown, Scope.Scope>
  done: () => Effect.Effect<void>
  download: (
    material: FactorMaterial
  ) => Effect.Effect<void, unknown, Scope.Scope>
}
export function factorMachine(work: FactorWork) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input: Schema.Struct({ enabled: Schema.Boolean }),
      context: Schema.Struct({
        enabled: Schema.Boolean,
        action: Action,
        material: Schema.NullOr(Material),
        request: Schema.NullOr(Request),
        error: Schema.String,
        failure: Schema.UndefinedOr(Schema.Unknown),
      }),
      events: {
        CHOOSE: Schema.Struct({ action: Action }),
        SUBMIT: Schema.Struct({ secret: Secret }),
        DONE: Schema.Struct({}),
        DOWNLOAD: Schema.Struct({}),
      },
    },
    actors: {
      request: createEffectLogic(({ input }: { input: FactorRequest }) =>
        Effect.exit(work.request(input))
      ),
      download: createEffectLogic(({ input }: { input: FactorMaterial }) =>
        Effect.exit(work.download(input))
      ),
    },
    actions: { done: (_args: object) => work.done() },
  }).createMachine({
    id: "auth-factor",
    initial: "opening",
    context: ({ input }) => ({
      enabled: input.enabled,
      action: "enable",
      material: null,
      request: null,
      error: "",
      failure: undefined,
    }),
    states: {
      opening: {
        always: ({ context }) => ({
          target: context.enabled ? "manage" : "password",
        }),
      },
      manage: {
        on: {
          CHOOSE: ({ context, event }) =>
            event.action === "codes" || event.action === "disable"
              ? {
                  target: "password",
                  context: { ...context, action: event.action, error: "" },
                }
              : undefined,
          DONE: (args, enq) => {
            enq(args.actions.done, args)
          },
        },
      },
      password: {
        on: {
          SUBMIT: ({ context, event }) => ({
            target: "requesting",
            context: {
              ...context,
              request: { action: context.action, secret: event.secret },
              error: "",
              failure: undefined,
            },
          }),
          DONE: (args, enq) => {
            enq(args.actions.done, args)
          },
        },
      },
      verify: {
        on: {
          SUBMIT: ({ context, event }) =>
            Redacted.value(event.secret).code?.length === 6
              ? {
                  target: "requesting",
                  context: {
                    ...context,
                    request: { action: "verify", secret: event.secret },
                    error: "",
                    failure: undefined,
                  },
                }
              : undefined,
          DONE: (args, enq) => {
            enq(args.actions.done, args)
          },
        },
      },
      requesting: {
        invoke: {
          src: "request",
          input: ({ context }) => context.request!,
          onDone: (args, enq) => {
            const { context, event } = args
            if (Exit.isFailure(event.output))
              return {
                target:
                  context.request!.action === "verify" ? "verify" : "password",
                context: {
                  ...context,
                  request: null,
                  error: authMessage(
                    event.output.cause,
                    "Could not confirm that change. Check your connection and try again. If codes were replaced, generate a new set."
                  ).message,
                  failure: event.output.cause,
                },
              }
            if (context.request!.action === "disable") {
              enq(args.actions.done, args)
              return {
                target: "done",
                context: { ...context, request: null, material: null },
              }
            }
            const verifying = context.request!.action === "enable"
            return {
              target: verifying ? "verify" : "codes",
              context: {
                ...context,
                request: null,
                material: event.output.value ?? context.material,
              },
            }
          },
        },
      },
      codes: {
        initial: "ready",
        on: {
          DONE: (args, enq) => {
            enq(args.actions.done, args)
            return {
              target: "done",
              context: { ...args.context, material: null },
            }
          },
        },
        states: {
          ready: {
            on: {
              DOWNLOAD: ({ context }) =>
                context.material ? { target: "downloading" } : undefined,
            },
          },
          downloading: {
            invoke: {
              src: "download",
              input: ({ context }) => context.material!,
              onDone: ({ context, event }) => ({
                target: "ready",
                context: Exit.isFailure(event.output)
                  ? {
                      ...context,
                      error:
                        "Could not download the codes. Copy them before closing.",
                      failure: event.output.cause,
                    }
                  : context,
              }),
            },
          },
        },
      },
      done: {},
    },
  })
}
