import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import { initialTransition, transition } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

export const reportAdmissionMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    context: Schema.Struct({
      recent: Schema.Array(Schema.Number),
      decision: Schema.Literals(["send", "reuse", "drop"]),
    }),
    events: {
      REPORT: Schema.Struct({ now: Schema.Number, known: Schema.Boolean }),
    },
  },
}).createMachine({
  id: "browser-report-admission",
  initial: "available",
  context: () => ({ recent: [], decision: "drop" }),
  on: {
    REPORT: ({ context, event }) => {
      if (event.known) return { context: { ...context, decision: "reuse" } }
      const recent = context.recent.filter((at) => at > event.now - 60_000)
      if (recent.length >= 5)
        return { target: ".limited", context: { recent, decision: "drop" } }
      recent.push(event.now)
      return {
        target: recent.length === 5 ? ".limited" : ".available",
        context: { recent, decision: "send" },
      }
    },
  },
  states: { available: {}, limited: {} },
})
export const initialReportAdmission = () =>
  initialTransition(reportAdmissionMachine)[0]
export const admitReport = (
  state: ReturnType<typeof initialReportAdmission>,
  now: number,
  known: boolean
) =>
  transition(reportAdmissionMachine, state, { type: "REPORT", now, known })[0]

/** One admitted report owns its fetch. Failure never schedules another report. */
export function browserReportMachine(
  work: Effect.Effect<string | undefined, unknown>
) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({ result: Schema.UndefinedOr(Schema.String) }),
      output: Schema.UndefinedOr(Schema.String),
    },
    actors: { send: createEffectLogic(Effect.exit(work)) },
  }).createMachine({
    id: "browser-report-request",
    initial: "sending",
    context: () => ({ result: undefined as string | undefined }),
    output: ({ context }) => context.result,
    states: {
      sending: {
        invoke: {
          src: "send",
          onDone: ({ event }) => ({
            target: "settled",
            context: {
              result: Exit.isSuccess(event.output)
                ? event.output.value
                : undefined,
            },
          }),
        },
      },
      settled: { type: "final" },
    },
  })
}
