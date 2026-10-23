import { createEffectLogic, setupEffect, withActorScope } from "@xstate/effect"
import { Effect, Exit, Schema, type Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

const index = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const longitude = Schema.Number.check(
  Schema.isBetween({ minimum: -180, maximum: 180 })
)
const latitude = Schema.Number.check(
  Schema.isBetween({ minimum: -90, maximum: 90 })
)
export const MapView = Schema.Struct({
  revision: index,
  places: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      address: Schema.String,
      longitude,
      latitude,
    })
  ).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  coordinates: Schema.UndefinedOr(
    Schema.Array(Schema.Tuple([longitude, latitude])).check(
      Schema.isMinLength(2),
      Schema.isMaxLength(1000)
    )
  ),
  dark: Schema.Boolean,
  selected: index,
})
export type MapView = typeof MapView.Type
export type MapSession = {
  readonly ready: Effect.Effect<void, unknown>
  readonly select: (selected: number) => Effect.Effect<void, unknown>
  readonly close: Effect.Effect<void>
}
const session = Schema.declare(
  (value): value is MapSession =>
    typeof value === "object" &&
    value !== null &&
    "ready" in value &&
    Effect.isEffect(value.ready) &&
    "close" in value &&
    Effect.isEffect(value.close) &&
    "select" in value &&
    typeof value.select === "function"
)
const selection = Schema.Struct({ session, selected: index })
const context = Schema.Struct({
  desired: MapView,
  current: MapView,
  session: Schema.NullOr(session),
  failure: Schema.UndefinedOr(Schema.Unknown),
})
type Context = typeof context.Type
const replace = (context: Context, view: MapView) =>
  view.revision < context.desired.revision
    ? undefined
    : {
        context: { ...context, desired: view },
      }

/** Owns one container lease. A replacement starts only after RELEASE completes. */
export function placesMapMachine(
  open: (view: MapView) => Effect.Effect<MapSession, unknown, Scope.Scope>
) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: { input: MapView, context, events: { VIEW: MapView } },
    actors: {
      open: createEffectLogic(({ input }: { input: MapView }) =>
        withActorScope(open(input))
      ),
      ready: createEffectLogic(({ input }: { input: MapSession }) =>
        Effect.exit(input.ready)
      ),
      release: createEffectLogic(({ input }: { input: MapSession }) =>
        Effect.exit(input.close)
      ),
    },
    actions: {
      select: ({ params }: { params?: unknown }) => {
        const input = Schema.decodeUnknownSync(selection)(params)
        return input.session.select(input.selected)
      },
    },
  }).createMachine({
    id: "places-map",
    initial: "opening",
    context: ({ input }) => ({
      desired: input,
      current: input,
      session: null,
      failure: undefined,
    }),
    on: {
      VIEW: ({ context, event }) =>
        replace(context, Schema.decodeUnknownSync(MapView)(event)),
    },
    states: {
      opening: {
        invoke: {
          src: "open",
          input: ({ context }) => context.current,
          onDone: ({ context, event }) => ({
            target:
              context.desired.revision === context.current.revision
                ? "active"
                : "releasing",
            context: { ...context, session: event.output },
          }),
          onError: ({ context, event }) => ({
            target: "unavailable",
            context: { ...context, failure: event.error },
          }),
        },
      },
      active: {
        initial: "loading",
        invoke: {
          src: "ready",
          input: ({ context }) => context.session!,
          onDone: (args, enq) => {
            const { context, event, actions } = args
            if (Exit.isFailure(event.output))
              return {
                target: "releasing",
                context: { ...context, failure: event.output.cause },
              }
            enq(actions.select, {
              ...args,
              params: {
                session: context.session!,
                selected: context.desired.selected,
              },
            })
            return { target: ".ready" }
          },
        },
        on: {
          VIEW: (args, enq) => {
            const { context, event, actions } = args
            if (event.revision < context.desired.revision) return
            const desired = Schema.decodeUnknownSync(MapView)(event)
            if (desired.revision === context.current.revision) {
              enq(actions.select, {
                ...args,
                params: {
                  session: context.session!,
                  selected: desired.selected,
                },
              })
              return { context: { ...context, desired } }
            }
            return { target: "releasing", context: { ...context, desired } }
          },
        },
        states: {
          loading: { after: { 15000: { target: "fallbackLoading" } } },
          // Keep the existing late-load recovery while making occupancy explicit.
          fallbackLoading: {},
          ready: {},
        },
        onError: ({ context, event }) => ({
          target: "releasing",
          context: { ...context, failure: event.error },
        }),
      },
      releasing: {
        invoke: {
          src: "release",
          input: ({ context }) => context.session!,
          onDone: ({ context, event }) => {
            if (Exit.isFailure(event.output))
              return {
                target: "blocked",
                context: { ...context, failure: event.output.cause },
              }
            const changed =
              context.desired.revision !== context.current.revision
            return {
              target: changed ? "opening" : "unavailable",
              context: {
                ...context,
                current: context.desired,
                session: null,
                failure: changed ? undefined : context.failure,
              },
            }
          },
        },
      },
      unavailable: {
        always: ({ context }) =>
          context.desired.revision !== context.current.revision
            ? {
                target: "opening",
                context: {
                  ...context,
                  current: context.desired,
                  failure: undefined,
                },
              }
            : undefined,
      },
      // An unconfirmed release cannot authorize another map in this container.
      blocked: {},
    },
  })
}
