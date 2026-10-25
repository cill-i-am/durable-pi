import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { ObjectId } from "@/objects/contracts"

export const objectCreationMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: Schema.NullOr(Schema.String),
    context: Schema.Struct({
      id: Schema.NullOr(Schema.String),
      selected: Schema.NullOr(Schema.String),
      revision: Schema.Int,
      started: Schema.Int,
      pending: Schema.Boolean,
    }),
    events: {
      BEGIN: Schema.Struct({ id: ObjectId }),
      VIEW: Schema.Struct({ selected: Schema.NullOr(Schema.String) }),
      STATUS: Schema.Struct({
        id: ObjectId,
        pending: Schema.Boolean,
        saved: Schema.Boolean,
      }),
      CANCEL: Schema.Struct({}),
    },
    emitted: { selected: Schema.Struct({ id: Schema.String }) },
  },
}).createMachine({
  id: "object-creation",
  initial: "idle",
  context: ({ input }) => ({
    id: null,
    selected: input,
    revision: 0,
    started: 0,
    pending: false,
  }),
  on: {
    VIEW: ({ context, event }) =>
      event.selected === context.selected
        ? undefined
        : {
            context: {
              ...context,
              selected: event.selected,
              revision: context.revision + 1,
            },
          },
  },
  states: {
    idle: {
      on: {
        BEGIN: ({ context, event }) => ({
          target: "editing",
          context: { ...context, id: event.id, started: context.revision },
        }),
      },
    },
    editing: {
      on: {
        STATUS: ({ context, event }, enq) => {
          if (event.id !== context.id) return
          if (event.saved) {
            if (
              context.revision === context.started &&
              context.selected === null
            )
              enq.emit({ type: "selected", id: event.id })
            return {
              target: "idle",
              context: { ...context, id: null, pending: false },
            }
          }
          return { context: { ...context, pending: event.pending } }
        },
        CANCEL: ({ context }) =>
          context.pending
            ? undefined
            : { target: "idle", context: { ...context, id: null } },
      },
    },
  },
})
