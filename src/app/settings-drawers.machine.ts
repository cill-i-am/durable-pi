import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import type { SettingsFrame } from "@/navigation/settings-stack"

const frames = Schema.Array(
  Schema.declare(
    (value): value is SettingsFrame =>
      typeof value === "object" &&
      value !== null &&
      "id" in value &&
      typeof value.id === "string" &&
      "href" in value &&
      typeof value.href === "string" &&
      "category" in value &&
      typeof value.category === "string"
  )
)
const route = Schema.Struct({
  href: Schema.String,
  frames,
  locked: Schema.Boolean,
})
const action = Schema.declare(
  (value): value is () => void => typeof value === "function"
)
export type SettingsDrawerRoute = typeof route.Type
export function settingsPrefix(
  left: readonly SettingsFrame[],
  right: readonly SettingsFrame[]
) {
  let index = 0
  while (index < left.length && left[index]?.id === right[index]?.id) index++
  return index
}
function reconcile(
  rendered: readonly SettingsFrame[],
  desired: readonly SettingsFrame[]
) {
  const prefix = settingsPrefix(rendered, desired)
  return prefix === rendered.length
    ? desired
    : [...desired.slice(0, prefix), ...rendered.slice(prefix)]
}
const context = Schema.Struct({
  route,
  rendered: frames,
  revision: Schema.Number,
  action: Schema.NullOr(action),
})
type Context = typeof context.Type
function removeClosed(
  current: Context,
  id: string,
  desired: readonly SettingsFrame[]
) {
  const index = current.rendered.findIndex((frame) => frame.id === id)
  if (index < settingsPrefix(current.rendered, desired) || index < 0)
    return current.rendered
  return reconcile(current.rendered.slice(0, index), desired)
}

/** Router owns destinations; native dialogs acknowledge closure. Only a matching
 * root close may dispatch the captured exit, with fresh navigation authority. */
export function settingsDrawersMachine(work: {
  navigate: (href: string, action: () => void) => Effect.Effect<void>
}) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input: route,
      context,
      events: {
        ROUTE: route,
        EXIT: Schema.Struct({ action }),
        CLOSED: Schema.Struct({ id: Schema.String, revision: Schema.Number }),
      },
    },
    actors: {
      navigate: createEffectLogic(({ input }: { input: Context }) =>
        work
          .navigate(input.route.href, input.action!)
          .pipe(Effect.as(input.route.href))
      ),
    },
  }).createMachine({
    id: "settings-drawers",
    initial: "active",
    context: ({ input }) => ({
      route: input,
      rendered: input.frames,
      revision: 0,
      action: null,
    }),
    states: {
      active: {
        on: {
          ROUTE: ({ context, event }) => ({
            context: {
              ...context,
              route: event,
              rendered: reconcile(context.rendered, event.frames),
              revision: context.revision + 1,
            },
          }),
          EXIT: ({ context, event }) =>
            context.route.locked || !context.rendered.length
              ? undefined
              : {
                  target: "closing",
                  context: {
                    ...context,
                    action: event.action,
                    revision: context.revision + 1,
                  },
                },
          CLOSED: ({ context, event }) =>
            event.revision !== context.revision
              ? undefined
              : {
                  context: {
                    ...context,
                    rendered: removeClosed(
                      context,
                      event.id,
                      context.route.frames
                    ),
                  },
                },
        },
      },
      closing: {
        on: {
          ROUTE: ({ context, event }) =>
            event.href !== context.route.href || event.locked
              ? {
                  target: "active",
                  context: {
                    route: event,
                    rendered: reconcile(context.rendered, event.frames),
                    revision: context.revision + 1,
                    action: null,
                  },
                }
              : undefined,
          CLOSED: ({ context, event }) =>
            event.revision !== context.revision
              ? undefined
              : event.id === context.rendered[0]?.id
                ? {
                    target: "navigating",
                    context: { ...context, rendered: [] },
                  }
                : {
                    context: {
                      ...context,
                      rendered: removeClosed(context, event.id, []),
                    },
                  },
        },
      },
      navigating: {
        on: {
          ROUTE: ({ context, event }) => ({
            context: {
              ...context,
              route: event,
              revision: context.revision + 1,
            },
          }),
        },
        invoke: {
          src: "navigate",
          input: ({ context }) => context,
          onDone: ({ context, event }) => ({
            target: context.route.href === event.output ? "closed" : "active",
            context: {
              ...context,
              rendered:
                context.route.href === event.output ? [] : context.route.frames,
              action: null,
            },
          }),
        },
      },
      closed: {
        on: {
          ROUTE: ({ context, event }) => ({
            target: "active",
            context: {
              route: event,
              rendered: event.frames,
              revision: context.revision + 1,
              action: null,
            },
          }),
        },
      },
    },
  })
}
