import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { initialTransition, transition, type EventFromLogic } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

import {
  Routine,
  RoutineConflict,
  RoutineRun,
  followingTime,
} from "./contracts"

export const RoutineRecord = Schema.Struct({
  ...Routine.fields,
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
})
export type RoutineRecord = typeof RoutineRecord.Type
const { status: _, ...fields } = RoutineRecord.fields
const Context = Schema.Struct(fields)
const trigger = Schema.Struct({
  trigger: RoutineRun.fields.trigger,
  now: Routine.fields.updatedAt,
})
const admission = Schema.Struct({
  trigger: RoutineRun.fields.trigger,
  revision: Routine.fields.revision,
})
const save = Schema.Struct({ routine: Routine })
const status = Schema.Struct({
  status: Routine.fields.status,
  now: Routine.fields.updatedAt,
  nextAt: Routine.fields.nextAt,
})
const update = ({ event }: { event: typeof save.Type }) => {
  const { status, ...context } = event.routine
  return {
    target: status,
    context: {
      ...context,
      schemaVersion: 1 as const,
      workflowVersion: 1 as const,
    },
  }
}
const change = ({
  context,
  event,
}: {
  context: typeof Context.Type
  event: typeof status.Type
}) => ({
  target: event.status,
  context: {
    ...context,
    revision: context.revision + 1,
    updatedAt: event.now,
    nextAt: event.nextAt,
  },
})

/** The saved domain record reconstructs availability without replaying triggers. */
export const routineMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    context: Context,
    input: Context,
    events: {
      CREATE: save,
      SAVE: save,
      STATUS: status,
      TRIGGER: trigger,
      ADMIT: admission,
    },
  },
}).createMachine({
  id: "routine-availability",
  version: "1",
  initial: "absent",
  context: ({ input }) => input,
  states: {
    absent: { on: { CREATE: update } },
    active: {
      on: {
        SAVE: update,
        STATUS: change,
        TRIGGER: ({ context, event }) =>
          event.trigger !== "scheduled" ||
          (context.nextAt !== null && context.nextAt <= event.now)
            ? {
                context: {
                  ...context,
                  nextAt:
                    event.trigger === "scheduled"
                      ? followingTime(
                          context.schedule,
                          context.nextAt!,
                          event.now
                        )
                      : context.nextAt,
                },
              }
            : undefined,
        ADMIT: ({ context, event }) =>
          context.revision === event.revision
            ? { context: { ...context } }
            : undefined,
      },
    },
    paused: {
      on: {
        SAVE: update,
        STATUS: change,
        TRIGGER: ({ context, event }) =>
          event.trigger === "manual" ? { context: { ...context } } : undefined,
        ADMIT: ({ context, event }) =>
          event.trigger === "manual" && context.revision === event.revision
            ? { context: { ...context } }
            : undefined,
      },
    },
    archived: { on: { STATUS: change } },
  },
})
export type RoutineEvent = EventFromLogic<typeof routineMachine>

export function newRoutineRecord(routine: Routine): RoutineRecord {
  const { status: _, ...context } = readRoutineRecord(routine)
  const [initial, effects] = initialTransition(routineMachine, context)
  const [next, created] = transition(routineMachine, initial, {
    type: "CREATE",
    routine,
  })
  if (effects.length || created.length)
    throw new Error("Unsupported routine creation effect")
  return readRoutineRecord({ ...next.context, status: next.value })
}
export function readRoutineRecord(raw: unknown): RoutineRecord {
  if (!raw || typeof raw !== "object")
    throw new Error("Invalid routine record; restore compatible data.")
  if (!("schemaVersion" in raw) && !("workflowVersion" in raw))
    return Schema.decodeUnknownSync(RoutineRecord)({
      ...Schema.decodeUnknownSync(Routine)(raw),
      schemaVersion: 1,
      workflowVersion: 1,
    })
  return Schema.decodeUnknownSync(RoutineRecord)(raw)
}
function restore(raw: unknown) {
  const { status, ...context } = readRoutineRecord(raw)
  return routineMachine.resolveState({ value: status, context })
}
export function routineAllows(
  raw: unknown,
  event: Extract<RoutineEvent, { type: "TRIGGER" | "ADMIT" }>
) {
  return restore(raw).can(event)
}
export function advanceRoutine(
  raw: unknown,
  event: RoutineEvent
): RoutineRecord {
  const current = restore(raw)
  if (!current.can(event))
    throw new RoutineConflict({
      message:
        "This routine no longer permits this change. Reload before trying again.",
    })
  const [next, effects] = transition(routineMachine, current, event)
  if (effects.length)
    throw new Error(`Unsupported routine effect: ${effects[0]!.type}`)
  return Schema.decodeUnknownSync(RoutineRecord)({
    ...next.context,
    status: next.value,
  })
}
