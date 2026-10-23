import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { initialTransition, transition, type EventFromLogic } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

import { RoutineRun, ROUTINE_BUDGET_MS } from "./contracts"

export const ROUTINE_ADMISSION_BUDGET_MS = 24 * 60 * 60_000
export const RoutineRunRecord = Schema.Struct({
  ...RoutineRun.fields,
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  admissionDeadline: RoutineRun.fields.createdAt,
  controlRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type RoutineRunRecord = typeof RoutineRunRecord.Type
const { status: _, ...fields } = RoutineRunRecord.fields
const Context = Schema.Struct(fields)
const time = { now: RoutineRun.fields.createdAt }
const events = {
  EXHAUSTED: Schema.Struct(time),
  ADMIT: Schema.Struct({ ...time, allowed: Schema.Boolean }),
  CANCEL: Schema.Struct({ ...time, reason: Schema.String }),
  DEADLINE: Schema.Struct(time),
  STOP: Schema.Struct(time),
  FINISH: Schema.Struct({
    ...time,
    turnId: RoutineRun.fields.turnId,
    status: Schema.Literals(["done", "failed", "cancelled"]),
    error: RoutineRun.fields.error,
  }),
}
const expired = (context: typeof Context.Type, now: number) => ({
  target: "failed",
  context: {
    ...context,
    finishedAt: now,
    error:
      "Routine admission expired after 24 hours. Check the model connection and conversation capacity, then run it again.",
  },
})
const uncertain = ({ context }: { context: typeof Context.Type }) => ({
  target: "unconfirmed",
  context: {
    ...context,
    error:
      "Routine recovery exhausted three attempts. Inspect the conversation, then use Stop to retry cancellation. The admitted reply still occupies this routine slot until its outcome is confirmed.",
  },
})
const finish = ({
  context,
  event,
}: {
  context: typeof Context.Type
  event: typeof events.FINISH.Type
}) =>
  event.turnId === context.turnId
    ? {
        target: event.status,
        context: {
          ...context,
          finishedAt: event.now,
          error: event.error?.slice(0, 1000) ?? null,
        },
      }
    : undefined

/** Pending authority, admitted occupancy and acknowledged terminal outcomes are
 * distinct. Stopping retains occupancy until Conversations acknowledges it. */
export const routineRunMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: { input: Context, context: Context, events },
}).createMachine({
  id: "routine-run",
  version: "1",
  initial: "pending",
  context: ({ input }) => input,
  states: {
    pending: {
      on: {
        EXHAUSTED: ({ context, event }) => ({
          target: "failed",
          context: {
            ...context,
            finishedAt: event.now,
            error:
              "Routine admission failed after three recovery attempts. Check the model connection and conversation capacity, then run it again.",
          },
        }),
        ADMIT: ({ context, event }) =>
          event.now >= context.admissionDeadline
            ? expired(context, event.now)
            : event.allowed
              ? {
                  target: "queued",
                  context: {
                    ...context,
                    deadline: event.now + ROUTINE_BUDGET_MS,
                  },
                }
              : {
                  target: "cancelled",
                  context: {
                    ...context,
                    finishedAt: event.now,
                    error: "Routine changed before admission.",
                  },
                },
        CANCEL: ({ context, event }) => ({
          target: "cancelled",
          context: { ...context, finishedAt: event.now, error: event.reason },
        }),
        DEADLINE: ({ context, event }) =>
          event.now >= context.admissionDeadline
            ? expired(context, event.now)
            : undefined,
      },
    },
    queued: {
      on: {
        EXHAUSTED: uncertain,
        FINISH: finish,
        STOP: { target: "stopping" },
        DEADLINE: ({ context, event }) =>
          context.deadline !== null && event.now >= context.deadline
            ? {
                target: "stopping",
                context: {
                  ...context,
                  error:
                    "The ten-minute routine budget expired. Waiting for the admitted reply to stop.",
                },
              }
            : undefined,
      },
    },
    stopping: { on: { FINISH: finish, EXHAUSTED: uncertain } },
    unconfirmed: { on: { FINISH: finish, STOP: { target: "stopping" } } },
    done: { type: "final" },
    failed: { type: "final" },
    cancelled: { type: "final" },
  },
})
export type RoutineRunEvent = EventFromLogic<typeof routineRunMachine>
export function newRoutineRunRecord(run: RoutineRun): RoutineRunRecord {
  const { status: _, ...context } = readRoutineRunRecord(run)
  const [initial, effects] = initialTransition(routineRunMachine, context)
  if (effects.length) throw new Error("Unsupported routine run creation effect")
  return readRoutineRunRecord({ ...initial.context, status: initial.value })
}
export function readRoutineRunRecord(raw: unknown): RoutineRunRecord {
  if (!raw || typeof raw !== "object")
    throw new Error("Invalid routine run; restore compatible data.")
  const value =
    !("schemaVersion" in raw) && !("workflowVersion" in raw)
      ? {
          ...Schema.decodeUnknownSync(RoutineRun)(raw),
          schemaVersion: 1,
          workflowVersion: 1,
          controlRevision: 0,
          admissionDeadline:
            Schema.decodeUnknownSync(RoutineRun)(raw).createdAt +
            ROUTINE_ADMISSION_BUDGET_MS,
        }
      : raw
  const record = Schema.decodeUnknownSync(RoutineRunRecord)(value)
  if (
    (record.status === "queued" ||
      record.status === "stopping" ||
      record.status === "unconfirmed") &&
    record.deadline === null
  )
    throw new Error(
      "Admitted routine has no execution deadline; restore compatible data."
    )
  if (
    ["done", "failed", "cancelled"].includes(record.status) &&
    record.finishedAt === null
  )
    throw new Error(
      "Terminal routine has no completion receipt; restore compatible data."
    )
  return record
}
export function advanceRoutineRun(
  raw: unknown,
  event: RoutineRunEvent
): RoutineRunRecord {
  const record = readRoutineRunRecord(raw)
  const { status, ...context } = record
  const current = routineRunMachine.resolveState({ value: status, context })
  const [next, effects] = transition(routineRunMachine, current, event)
  if (effects.some((effect) => effect.type !== "@xstate.terminate"))
    throw new Error(`Unsupported routine run effect: ${effects[0]!.type}`)
  return readRoutineRunRecord({
    ...next.context,
    status: next.value,
    controlRevision:
      record.controlRevision +
      (next.value !== current.value ||
      JSON.stringify(next.context) !== JSON.stringify(current.context)
        ? 1
        : 0),
  })
}
export const routineRunWake = (raw: unknown, now: number) => {
  const run = readRoutineRunRecord(raw)
  switch (run.status) {
    case "pending":
      return Math.min(run.admissionDeadline, now + 60_000)
    case "queued":
      return Math.min(run.deadline!, now + 5000)
    case "stopping":
      return now + 5000
    default:
      return undefined
  }
}
