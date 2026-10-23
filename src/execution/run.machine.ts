import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import {
  initialTransition,
  transition,
  type EventFromLogic,
  type ExecutableEffect,
} from "xstate"
import { standardSchemaValidator } from "xstate/validation"

import {
  CodeRun,
  CodeOutput,
  ExecutionFailure,
  type RunInput,
} from "./contracts"

export const ExecutionRecord = Schema.Struct({
  ...CodeRun.fields,
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  attemptId: Schema.String,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  occupancy: Schema.Struct({
    state: Schema.Literals(["held", "blocked", "free"]),
    ownerId: Schema.NullOr(Schema.String),
  }),
})
export type ExecutionRecord = typeof ExecutionRecord.Type
const { status: _, ...fields } = ExecutionRecord.fields
const Context = Schema.Struct({
  ...fields,
  rejection: Schema.NullOr(Schema.String),
})
const fence = { attemptId: Schema.String, revision: Schema.Number }
const bump = (context: typeof Context.Type) => ({
  ...context,
  revision: context.revision + 1,
})
export const executionRunMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: Context,
    context: Context,
    events: {
      ADMIT: Schema.Struct({
        writable: Schema.Boolean,
        busy: Schema.Boolean,
        total: Schema.Number,
      }),
      FINISH: Schema.Struct({
        ...fence,
        output: CodeOutput,
        now: Schema.Number,
      }),
      CANCEL: Schema.Struct({ ...fence, now: Schema.Number }),
      INTERRUPT: Schema.Struct({ ...fence, now: Schema.Number }),
      RELEASE: Schema.Struct({
        attemptId: Schema.String,
        confirmed: Schema.Boolean,
      }),
      RECOVER: Schema.Struct({ now: Schema.Number }),
    },
  },
}).createMachine({
  id: "execution-run",
  version: "1",
  initial: "absent",
  context: ({ input }) => input,
  on: {
    RELEASE: ({ context, event }) =>
      context.occupancy.ownerId === event.attemptId &&
      context.occupancy.state !== "free"
        ? {
            context: {
              ...bump(context),
              occupancy: {
                state: event.confirmed ? "free" : "blocked",
                ownerId: event.confirmed ? null : event.attemptId,
              },
            },
          }
        : undefined,
    RECOVER: ({ context }) => ({
      context: {
        ...bump(context),
        occupancy: { state: "free", ownerId: null },
      },
    }),
  },
  states: {
    absent: {
      on: {
        ADMIT: ({ context, event }) => {
          const rejection = !event.writable
            ? "Restore this bot before running code."
            : event.busy
              ? "Wait for the current run or cancel it first."
              : event.total >= 500
                ? "This bot has reached its 500-run history limit."
                : null
          return {
            target: rejection ? "rejected" : "running",
            context: { ...context, rejection },
          }
        },
      },
    },
    running: {
      on: {
        FINISH: ({ context, event }) =>
          context.attemptId === event.attemptId &&
          context.revision === event.revision
            ? {
                target: event.output.error ? "failed" : "succeeded",
                context: {
                  ...bump(context),
                  output: event.output,
                  finishedAt: event.now,
                },
              }
            : undefined,
        CANCEL: ({ context, event }) =>
          context.attemptId === event.attemptId &&
          context.revision === event.revision
            ? {
                target: "cancelled",
                context: {
                  ...bump(context),
                  output: null,
                  finishedAt: event.now,
                },
              }
            : undefined,
        INTERRUPT: ({ context, event }) =>
          context.attemptId === event.attemptId &&
          context.revision === event.revision
            ? {
                target: "interrupted",
                context: {
                  ...bump(context),
                  output: null,
                  finishedAt: event.now,
                },
              }
            : undefined,
        RECOVER: ({ context, event }) => ({
          target: "interrupted",
          context: {
            ...bump(context),
            output: null,
            finishedAt: event.now,
            occupancy: { state: "free", ownerId: null },
          },
        }),
      },
    },
    succeeded: {},
    failed: {},
    cancelled: {},
    interrupted: {},
    rejected: {},
  },
})
export type ExecutionEvent = EventFromLogic<typeof executionRunMachine>
const supported = (effects: readonly ExecutableEffect[]) => {
  if (effects.length)
    throw new Error(`Unsupported execution run effect: ${effects[0]!.type}`)
}
export function restoreExecutionRecord(saved: unknown): ExecutionRecord {
  if (typeof saved !== "object" || saved === null)
    throw new Error("Invalid execution record")
  if (
    "schemaVersion" in saved ||
    "workflowVersion" in saved ||
    "attemptId" in saved ||
    "revision" in saved ||
    "occupancy" in saved
  )
    return Schema.decodeUnknownSync(ExecutionRecord)(saved)
  const legacy = Schema.decodeUnknownSync(CodeRun)(saved)
  const attemptId = `legacy:${legacy.id}`
  return Schema.decodeUnknownSync(ExecutionRecord)({
    ...legacy,
    schemaVersion: 1,
    workflowVersion: 1,
    attemptId,
    revision: 0,
    occupancy:
      legacy.status === "running"
        ? { state: "held", ownerId: attemptId }
        : { state: "free", ownerId: null },
  })
}
export function advanceExecutionRecord(
  saved: unknown,
  event: ExecutionEvent
): ExecutionRecord {
  const { status, ...context } = restoreExecutionRecord(saved)
  const [next, effects] = transition(
    executionRunMachine,
    executionRunMachine.resolveState({
      value: status,
      context: { ...context, rejection: null },
    }),
    event
  )
  supported(effects)
  return Schema.decodeUnknownSync(ExecutionRecord)({
    ...next.context,
    status: next.value,
  })
}
export function newExecutionRecord(
  input: RunInput,
  writable: boolean,
  busy: boolean,
  total: number,
  now: number,
  attemptId: string
): ExecutionRecord {
  const [initial, effects] = initialTransition(executionRunMachine, {
    id: input.id,
    label: (input.code.split("\n")[0] ?? "").slice(0, 100),
    input: { code: input.code, data: input.data },
    createdAt: now,
    finishedAt: null,
    output: null,
    schemaVersion: 1,
    workflowVersion: 1,
    revision: 0,
    attemptId,
    occupancy: { state: "held", ownerId: attemptId },
    rejection: null,
  })
  supported(effects)
  const [next, actions] = transition(executionRunMachine, initial, {
    type: "ADMIT",
    writable,
    busy,
    total,
  })
  supported(actions)
  if (next.context.rejection)
    throw new ExecutionFailure({ message: next.context.rejection })
  return Schema.decodeUnknownSync(ExecutionRecord)({
    ...next.context,
    status: next.value,
  })
}
