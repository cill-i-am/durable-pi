import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { initialTransition, transition } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

import { PlanFailure, PlanId, PlanReceipt } from "./contracts"
import type { PlanBinding, PlanOperation } from "./ledger"

const Binding = Schema.Struct({
  planId: Schema.Union([Schema.Literal(""), PlanId]),
  cancelled: Schema.Boolean,
})
const BindingContext = Schema.Struct({ planId: Binding.fields.planId })
const bound = (planId: string, id: string) => {
  if (planId && planId !== id)
    throw new PlanFailure({
      code: "conflict",
      message: "This run already belongs to a different logical task.",
    })
}
const cancelled = () => {
  throw new PlanFailure({
    code: "cancelled",
    message: "This run was cancelled.",
  })
}
export const planBindingMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: BindingContext,
    context: BindingContext,
    events: {
      CHECK: Schema.Struct({ id: PlanId }),
      BIND: Schema.Struct({ id: PlanId }),
      CANCEL: Schema.Struct({}),
    },
  },
}).createMachine({
  id: "plan-binding",
  version: "1",
  context: ({ input }) => input,
  initial: "available",
  states: {
    available: {
      on: {
        CHECK: ({ context, event }) => {
          bound(context.planId, event.id)
        },
        BIND: ({ context, event }) => {
          bound(context.planId, event.id)
          return { context: { planId: event.id } }
        },
        CANCEL: { target: "cancelled" },
      },
    },
    cancelled: {
      on: { CHECK: cancelled, BIND: cancelled, CANCEL: {} },
    },
  },
})
export function restorePlanBinding(raw: unknown): PlanBinding {
  return Schema.decodeUnknownSync(Binding)(raw)
}
export function advancePlanBinding(
  raw: unknown,
  event: { type: "CHECK" | "BIND"; id: string } | { type: "CANCEL" }
): PlanBinding {
  const saved = restorePlanBinding(raw)
  const snapshot = planBindingMachine.resolveState({
    value: saved.cancelled ? "cancelled" : "available",
    context: { planId: saved.planId },
  })
  const [next, effects] = transition(planBindingMachine, snapshot, event)
  if (effects.length) throw new Error("Plan binding cannot run effects")
  return { planId: next.context.planId, cancelled: next.matches("cancelled") }
}

const Operation = Schema.Struct({
  digest: Schema.String,
  receipt: Schema.NullOr(PlanReceipt),
}).check(Schema.makeFilter((saved) => !!saved.digest === !!saved.receipt))
const exact = (saved: PlanOperation, digest: string) => {
  if (saved.digest !== digest)
    throw new PlanFailure({
      code: "conflict",
      message: "This tool operation belongs to another update.",
    })
}
export const planOperationMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: Operation,
    context: Operation,
    events: {
      CHECK: Schema.Struct({ digest: Schema.String }),
      COMMIT: Schema.Struct({ digest: Schema.String, receipt: PlanReceipt }),
    },
  },
}).createMachine({
  id: "plan-operation",
  version: "1",
  context: ({ input }) => input,
  initial: "pending",
  states: {
    pending: {
      on: {
        CHECK: {},
        COMMIT: ({ event }) => ({
          target: "committed",
          context: { digest: event.digest, receipt: event.receipt },
        }),
      },
    },
    committed: {
      on: {
        CHECK: ({ context, event }) => {
          exact(context, event.digest)
        },
        COMMIT: ({ context, event }) => {
          exact(context, event.digest)
          if (JSON.stringify(context.receipt) !== JSON.stringify(event.receipt))
            throw new PlanFailure({
              code: "conflict",
              message: "This tool operation already has a different receipt.",
            })
        },
      },
    },
  },
})
export function restorePlanOperation(raw: unknown): PlanOperation {
  return Schema.decodeUnknownSync(Operation)(raw)
}
export function advancePlanOperation(
  raw: unknown,
  event:
    | { type: "CHECK"; digest: string }
    | { type: "COMMIT"; digest: string; receipt: PlanReceipt }
): PlanOperation {
  const saved = restorePlanOperation(raw)
  const [fresh, initial] = initialTransition(planOperationMachine, saved)
  if (initial.length)
    throw new Error("Plan operation cannot initialize effects")
  const snapshot = saved.receipt
    ? planOperationMachine.resolveState({ value: "committed", context: saved })
    : fresh
  const [next, effects] = transition(planOperationMachine, snapshot, event)
  if (effects.length) throw new Error("Plan operation cannot run effects")
  return restorePlanOperation(next.context)
}
export function planReplay(operation: PlanOperation, digest: string) {
  const { receipt } = advancePlanOperation(operation, { type: "CHECK", digest })
  return receipt ? { ...receipt, reopened: [...receipt.reopened] } : undefined
}
