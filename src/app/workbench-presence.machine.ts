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

/** Router owns the requested view. This actor only retains the rendered view
 * until its matching native exit-animation acknowledgement. */
export const workbenchPresenceMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: route,
    context: Schema.Struct({ ...route.fields, revision: Schema.Number }),
    events: {
      ROUTE: route,
      CLOSED: Schema.Struct({ revision: Schema.Number }),
    },
  },
}).createMachine({
  id: "workbench-presence",
  initial: "restored",
  context: ({ input }) => ({ ...input, revision: 0 }),
  on: {
    ROUTE: ({ context, event }) =>
      event.panel
        ? {
            target: ".open",
            context: {
              panel: event.panel,
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
