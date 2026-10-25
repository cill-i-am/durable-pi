import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { AgentId } from "@/agents/contracts"

const action = Schema.Literals([
  "browser",
  "code",
  "apps",
  "terminal",
  "routines",
  "objects",
  "activity",
  "files",
  "memory",
  "create",
  "edit",
  "archive",
  "hide-workbench",
  "sign-out",
  "security",
  "settings",
])
export type WorkspaceAction = typeof action.Type
const command = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("action"), id: action }),
  Schema.Struct({ kind: Schema.Literal("agent"), id: Schema.toType(AgentId) }),
])
export type WorkspaceCommand = typeof command.Type

/** Base UI owns focus and animation; only its matching close acknowledgement
 * authorizes the captured command. Reopening revokes that pending command. */
export function workspaceCommandMachine(work: {
  unlocked: () => boolean
  dispatch: (command: WorkspaceCommand) => Effect.Effect<void>
}) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        revision: Schema.Number,
        pending: Schema.NullOr(command),
        skipFocus: Schema.Boolean,
      }),
      events: {
        OPEN: Schema.Struct({}),
        TOGGLE: Schema.Struct({}),
        CLOSE: Schema.Struct({}),
        LOCK: Schema.Struct({}),
        CHOOSE: Schema.Struct({ command }),
        CLOSED: Schema.Struct({ revision: Schema.Number }),
      },
    },
    actors: {
      dispatch: createEffectLogic(({ input }: { input: WorkspaceCommand }) =>
        work.dispatch(input)
      ),
    },
  }).createMachine({
    id: "workspace-command",
    initial: "closed",
    context: { revision: 0, pending: null, skipFocus: false },
    on: {
      LOCK: ({ context }) => ({
        target: ".closed",
        context: {
          revision: context.revision + 1,
          pending: null,
          skipFocus: false,
        },
      }),
    },
    states: {
      closed: {
        on: {
          OPEN: ({ context }) =>
            work.unlocked()
              ? {
                  target: "open",
                  context: {
                    revision: context.revision + 1,
                    pending: null,
                    skipFocus: false,
                  },
                }
              : {},
          TOGGLE: ({ context }) =>
            work.unlocked()
              ? {
                  target: "open",
                  context: {
                    revision: context.revision + 1,
                    pending: null,
                    skipFocus: false,
                  },
                }
              : {},
          CHOOSE: ({ context, event }) =>
            work.unlocked()
              ? {
                  target: "dispatching",
                  context: { ...context, pending: event.command },
                }
              : {},
        },
      },
      open: {
        on: {
          CLOSE: { target: "closing" },
          TOGGLE: { target: "closing" },
          CHOOSE: ({ context, event }) =>
            work.unlocked()
              ? {
                  target: "closing",
                  context: {
                    ...context,
                    pending: event.command,
                    skipFocus: true,
                  },
                }
              : {},
        },
      },
      closing: {
        on: {
          OPEN: ({ context }) =>
            work.unlocked()
              ? {
                  target: "open",
                  context: {
                    revision: context.revision + 1,
                    pending: null,
                    skipFocus: false,
                  },
                }
              : {},
          TOGGLE: ({ context }) =>
            work.unlocked()
              ? {
                  target: "open",
                  context: {
                    revision: context.revision + 1,
                    pending: null,
                    skipFocus: false,
                  },
                }
              : {},
          CLOSED: ({ context, event }) =>
            event.revision !== context.revision
              ? {}
              : context.pending && work.unlocked()
                ? { target: "dispatching" }
                : { target: "closed", context: { ...context, pending: null } },
        },
      },
      dispatching: {
        invoke: {
          src: "dispatch",
          input: ({ context }) => context.pending!,
          onDone: ({ context }) => ({
            target: "closed",
            context: { ...context, pending: null },
          }),
        },
      },
    },
  })
}
