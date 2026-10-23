import { setupEffect } from "@xstate/effect"
import { Cause, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import type { ExecutionStorageError } from "./contracts"

const failure = Schema.declare(
  (value): value is Cause.Cause<ExecutionStorageError> => Cause.isCause(value)
)
/** Admission closes before the host joins any child or releases its scope. */
export const executionHostMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    context: Schema.Struct({ failure: Schema.UndefinedOr(failure) }),
    events: {
      CLOSE: Schema.Struct({}),
      CLOSED: Schema.Struct({}),
      FAILED: Schema.Struct({ cause: failure }),
    },
  },
}).createMachine({
  id: "execution-host",
  context: () => ({
    failure: undefined as Cause.Cause<ExecutionStorageError> | undefined,
  }),
  initial: "open",
  on: { FAILED: ({ event }) => ({ context: { failure: event.cause } }) },
  states: {
    open: {
      on: {
        CLOSE: { target: "closing" },
        FAILED: ({ event }) => ({
          target: "failed",
          context: { failure: event.cause },
        }),
      },
    },
    failed: { on: { CLOSE: { target: "closing" } } },
    closing: { on: { CLOSED: { target: "closed" } } },
    closed: { type: "final" },
  },
})
