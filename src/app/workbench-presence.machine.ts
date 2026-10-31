import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import type { Workbench, WorkspaceSearch } from "@/navigation/workspace"

const panel = Schema.Literals([
  "browser",
  "terminal",
  "files",
  "apps",
  "activity",
  "objects",
  "memory",
  "code",
  "routines",
])
const search = Schema.declare(
  (value): value is WorkspaceSearch =>
    typeof value === "object" && value !== null
)
const route = Schema.Struct({
  panel: Schema.NullOr(panel),
  search,
  held: Schema.Boolean,
})
export type WorkbenchView = {
  panel: Workbench | null
  search: WorkspaceSearch
  held?: boolean
}

/** Router owns the requested view. Native exit acknowledgement releases the
 * visible view; the last panel keeps its local tab session mounted per agent. */
export const workbenchPresenceMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: route,
    context: Schema.Struct({
      ...route.fields,
      retainedPanel: Schema.NullOr(panel),
      revision: Schema.Number,
    }),
    events: {
      ROUTE: route,
      CLOSED: Schema.Struct({ revision: Schema.Number }),
    },
  },
}).createMachine({
  id: "workbench-presence",
  initial: "restored",
  context: ({ input }) => ({
    ...input,
    retainedPanel: input.panel,
    revision: 0,
  }),
  on: {
    ROUTE: ({ context, event }) =>
      event.panel
        ? {
            target: ".open",
            context: {
              panel: event.panel,
              retainedPanel: event.panel,
              search: event.search,
              held: event.held,
              revision: context.revision + 1,
            },
          }
        : context.panel
          ? {
              target: event.held ? ".held" : ".closing",
              context: {
                ...context,
                held: event.held,
                revision: context.revision + 1,
              },
            }
          : {},
  },
  states: {
    restored: {
      always: ({ context }) => ({ target: context.panel ? "open" : "closed" }),
    },
    open: {},
    held: {},
    closing: {
      on: {
        CLOSED: ({ context, event }) =>
          event.revision === context.revision
            ? { target: "closed", context: { ...context, panel: null } }
            : {},
      },
    },
    closed: {},
  },
})
