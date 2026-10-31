import { setupEffect } from "@xstate/effect"
import { Effect, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

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
const facts = Schema.Struct({
  panel,
  open: Schema.Boolean,
  locked: Schema.Boolean,
  overlayOpen: Schema.Boolean,
})
export type WorkbenchTabsInput = typeof facts.Type
const navigation = Schema.Struct({ from: panel, panel: Schema.NullOr(panel) })
export type WorkbenchTabNavigation = typeof navigation.Type

/** The router owns the active panel. This session owns only opened tab order,
 * presentation and command admission; a request never changes the route fact. */
export function workbenchTabsMachine(work: {
  navigate: (request: WorkbenchTabNavigation) => Effect.Effect<void>
}) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input: facts,
      context: Schema.Struct({
        ...facts.fields,
        tabs: Schema.Array(panel),
        expanded: Schema.Boolean,
        revision: Schema.Number,
      }),
      events: {
        OBSERVE: facts,
        SELECT: Schema.Struct({ panel }),
        CLOSE_TAB: Schema.Struct({ panel }),
        HIDE: Schema.Struct({}),
        EXPAND: Schema.Struct({ expanded: Schema.Boolean }),
        SHOW_TABS: Schema.Struct({}),
        SHOW_TOOLS: Schema.Struct({}),
        DISMISS: Schema.Struct({ revision: Schema.Number }),
      },
    },
    actions: {
      navigate: ({ params }: { params?: unknown }) =>
        work.navigate(Schema.decodeUnknownSync(navigation)(params)),
    },
  }).createMachine({
    id: "workbench-tabs",
    initial: "restored",
    context: ({ input }) => ({
      ...input,
      tabs: [input.panel],
      expanded: false,
      revision: 0,
    }),
    on: {
      OBSERVE: ({ context, event }) => ({
        target: !event.open
          ? ".closed"
          : !context.open ||
              event.panel !== context.panel ||
              event.locked ||
              event.overlayOpen
            ? ".open.view"
            : undefined,
        context: {
          ...context,
          panel: event.panel,
          open: event.open,
          locked: event.locked,
          overlayOpen: event.overlayOpen,
          tabs:
            !event.open || context.tabs.includes(event.panel)
              ? context.tabs
              : [...context.tabs, event.panel],
          expanded: event.open && context.expanded,
          revision: context.revision + 1,
        },
      }),
    },
    states: {
      restored: {
        always: ({ context }) => ({ target: context.open ? "open" : "closed" }),
      },
      closed: {},
      open: {
        initial: "view",
        on: {
          SELECT: (args, enq) => {
            const { context, event } = args
            if (context.locked || context.overlayOpen) return {}
            enq(args.actions.navigate, {
              ...args,
              params: { from: context.panel, panel: event.panel },
            })
            return {
              target: ".view",
              context: {
                ...context,
                tabs: context.tabs.includes(event.panel)
                  ? context.tabs
                  : [...context.tabs, event.panel],
                revision: context.revision + 1,
              },
            }
          },
          CLOSE_TAB: (args, enq) => {
            const { context, event } = args
            if (
              context.locked ||
              context.overlayOpen ||
              !context.tabs.includes(event.panel)
            )
              return {}
            const index = context.tabs.indexOf(event.panel)
            const tabs = context.tabs.filter((id) => id !== event.panel)
            if (event.panel === context.panel) {
              enq(args.actions.navigate, {
                ...args,
                params: {
                  from: context.panel,
                  panel: tabs[Math.min(index, tabs.length - 1)] ?? null,
                },
              })
            }
            return {
              target: ".view",
              context: { ...context, tabs, revision: context.revision + 1 },
            }
          },
          HIDE: (args, enq) => {
            if (args.context.locked || args.context.overlayOpen) return {}
            enq(args.actions.navigate, {
              ...args,
              params: { from: args.context.panel, panel: null },
            })
            return { target: ".view" }
          },
          EXPAND: ({ context, event }) =>
            context.locked || context.overlayOpen
              ? {}
              : {
                  target: ".view",
                  context: { ...context, expanded: event.expanded },
                },
          SHOW_TABS: ({ context }) =>
            context.locked || context.overlayOpen
              ? {}
              : {
                  target: ".tabs",
                  context: { ...context, revision: context.revision + 1 },
                },
          SHOW_TOOLS: ({ context }) =>
            context.locked || context.overlayOpen
              ? {}
              : {
                  target: ".tools",
                  context: { ...context, revision: context.revision + 1 },
                },
          DISMISS: ({ context, event }) =>
            event.revision === context.revision ? { target: ".view" } : {},
        },
        states: { view: {}, tabs: {}, tools: {} },
      },
    },
  })
}
