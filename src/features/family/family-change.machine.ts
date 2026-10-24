import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

export const FamilyChange = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("invite"), email: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("resend"),
    id: Schema.String,
    email: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("cancel"), id: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("remove"),
    id: Schema.String,
    name: Schema.String,
  }),
])
export type FamilyChange = typeof FamilyChange.Type
export function familyChangeMachine(ports: {
  change: (
    command: FamilyChange
  ) => Effect.Effect<{ ok: boolean; message: string }>
  refresh: Effect.Effect<void>
}) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        command: Schema.NullOr(FamilyChange),
        notice: Schema.String,
        error: Schema.String,
      }),
      events: {
        CHANGE: Schema.Struct({ command: FamilyChange }),
        RESET: Schema.Struct({}),
      },
    },
    actors: {
      change: createEffectLogic(({ input }: { input: FamilyChange }) =>
        ports.change(input)
      ),
      refresh: createEffectLogic(() => ports.refresh),
    },
  }).createMachine({
    id: "family-change",
    initial: "idle",
    context: { command: null, notice: "", error: "" },
    states: {
      idle: {
        on: {
          CHANGE: ({ context, event }) => ({
            target: "changing",
            context: {
              ...context,
              command: event.command,
              notice: "",
              error: "",
            },
          }),
          RESET: ({ context }) => ({
            context: { ...context, command: null, notice: "", error: "" },
          }),
        },
      },
      changing: {
        invoke: {
          src: "change",
          input: ({ context }) => context.command!,
          onDone: ({ context, event }) => ({
            target: "refreshing",
            context: {
              ...context,
              notice: event.output.ok ? event.output.message : "",
              error: event.output.ok ? "" : event.output.message,
            },
          }),
        },
      },
      refreshing: { invoke: { src: "refresh", onDone: { target: "idle" } } },
    },
  })
}
