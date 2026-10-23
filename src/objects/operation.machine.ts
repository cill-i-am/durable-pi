import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import {
  describeExecutableEffect,
  transition,
  type EventFromLogic,
} from "xstate"
import { standardSchemaValidator } from "xstate/validation"

import { MutationReceipt, ObjectFailure } from "./contracts"

const Context = Schema.Struct({
  digest: Schema.String,
  receipt: Schema.NullOr(MutationReceipt),
})
const Result = Schema.Union([
  Schema.Struct({ type: Schema.Literal("admit") }),
  Schema.Struct({ type: Schema.Literal("replay"), receipt: MutationReceipt }),
  Schema.Struct({ type: Schema.Literal("cancel"), applied: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("committed") }),
])

/** The native operation document is the only authority. These synchronous
 * decisions run inside its existing Pi commit, without an actor or a journal. */
export const objectOperationMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    context: Context,
    events: {
      INSPECT: Schema.Struct({ digest: Schema.String }),
      COMMIT: Schema.Struct({
        digest: Schema.String,
        receipt: MutationReceipt,
      }),
      CANCEL: Schema.Struct({}),
    },
    emitted: { result: Schema.Struct({ value: Result }) },
  },
}).createMachine({
  id: "object-operation",
  version: "1",
  context: { digest: "", receipt: null as MutationReceipt | null },
  initial: "open",
  states: {
    open: {
      on: {
        INSPECT: (_, enq) => {
          enq.emit({ type: "result", value: { type: "admit" } })
        },
        COMMIT: ({ event }, enq) => {
          enq.emit({ type: "result", value: { type: "committed" } })
          return {
            target: "applied",
            context: { digest: event.digest, receipt: { ...event.receipt } },
          }
        },
        CANCEL: (_, enq) => {
          enq.emit({
            type: "result",
            value: { type: "cancel", applied: false },
          })
          return { target: "cancelled" }
        },
      },
    },
    applied: {
      on: {
        INSPECT: ({ context, event }, enq) => {
          if (context.digest !== event.digest)
            throw new ObjectFailure({
              code: "conflict",
              message: "This operation ID belongs to another change.",
            })
          enq.emit({
            type: "result",
            value: { type: "replay", receipt: { ...context.receipt! } },
          })
        },
        CANCEL: (_, enq) => {
          enq.emit({ type: "result", value: { type: "cancel", applied: true } })
        },
      },
    },
    cancelled: {
      on: {
        INSPECT: () => {
          throw new ObjectFailure({
            code: "cancelled",
            message: "This change was cancelled. Start a new edit.",
          })
        },
        CANCEL: (_, enq) => {
          enq.emit({
            type: "result",
            value: { type: "cancel", applied: false },
          })
        },
      },
    },
  },
})

export const ObjectOperationRecord = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  workflowVersion: Schema.Literal(1),
  libraryVersion: Schema.Literal("6.0.0-alpha.68/1.0.0-alpha.8"),
  piVersion: Schema.Literal("1.3.0"),
  value: Schema.Literals(["open", "applied", "cancelled"]),
  ...Context.fields,
}).check(
  Schema.makeFilter((record) =>
    record.value === "applied"
      ? record.receipt !== null && record.digest.length > 0
      : record.receipt === null && record.digest === ""
  )
)
export type ObjectOperationRecord = typeof ObjectOperationRecord.Type

export const incompatibleObjectOperation = () =>
  new ObjectFailure({
    code: "unavailable",
    message:
      "This saved object operation requires a compatible application version. Keep the saved data and use a compatible version before continuing.",
  })

const Versions = Schema.Struct({
  schemaVersion: Schema.Number,
  workflowVersion: Schema.Number,
  libraryVersion: Schema.String,
  piVersion: Schema.String,
})
export function restoreObjectOperation(saved: unknown) {
  const versions = Schema.decodeUnknownSync(Versions)(saved)
  if (
    versions.schemaVersion !== 2 ||
    versions.workflowVersion !== 1 ||
    versions.libraryVersion !== "6.0.0-alpha.68/1.0.0-alpha.8" ||
    versions.piVersion !== "1.3.0"
  )
    throw incompatibleObjectOperation()
  return Schema.decodeUnknownSync(ObjectOperationRecord)(saved)
}

export const newObjectOperation = (): ObjectOperationRecord => ({
  schemaVersion: 2,
  workflowVersion: 1,
  libraryVersion: "6.0.0-alpha.68/1.0.0-alpha.8",
  piVersion: "1.3.0",
  value: "open",
  digest: "",
  receipt: null,
})

const LegacyOperation = Schema.Struct({
  ...Context.fields,
  cancelled: Schema.Boolean,
})
export function migrateObjectOperation(saved: unknown, version: number) {
  if (version !== 1)
    throw new Error(`Unsupported object operation document version ${version}`)
  const legacy = Schema.decodeUnknownSync(LegacyOperation)(saved, {
    onExcessProperty: "error",
  })
  return Schema.decodeUnknownSync(ObjectOperationRecord)({
    ...newObjectOperation(),
    value: legacy.cancelled ? "cancelled" : legacy.receipt ? "applied" : "open",
    digest: legacy.digest,
    receipt: legacy.receipt,
  })
}

export function decideObjectOperation(
  saved: unknown,
  event: EventFromLogic<typeof objectOperationMachine>
) {
  const state = restoreObjectOperation(saved)
  const snapshot = objectOperationMachine.resolveState({
    value: state.value,
    context: { digest: state.digest, receipt: state.receipt },
  })
  const [next, effects] = transition(objectOperationMachine, snapshot, event)
  const results = effects.map((effect) => {
    const descriptor = describeExecutableEffect(effect)
    if (descriptor.kind === "emit")
      return Schema.decodeUnknownSync(
        Schema.Struct({ type: Schema.Literal("result"), value: Result })
      )(descriptor.event).value
    throw new Error(`Unsupported object operation effect: ${effect.type}`)
  })
  if (results.length !== 1)
    throw new Error("Object operation event did not produce one decision")
  return {
    state: Schema.decodeUnknownSync(ObjectOperationRecord)({
      ...state,
      value: next.value,
      ...next.context,
    }),
    result: results[0]!,
    changed: next.value !== state.value,
  }
}
