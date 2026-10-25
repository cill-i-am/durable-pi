import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Cause, Effect, Exit, Schema, type Scope } from "effect"
import type { EventFromLogic, SnapshotFrom, StateValue } from "xstate"
import { adjacencyMapToArray, getAdjacencyMap } from "xstate/graph"
import { standardSchemaValidator } from "xstate/validation"

export const LabScenario = Schema.Literals([
  "success",
  "error",
  "uncertain",
  "hold",
])
export type LabScenario = typeof LabScenario.Type
const delay = Schema.Number.check(
  Schema.isFinite(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(60_000)
)
export const LabRequest = Schema.Struct({
  id: Schema.String,
  generation: Schema.Number,
  scenario: LabScenario,
  delayMs: delay,
})
export type LabRequest = typeof LabRequest.Type
export class LabIssue extends Schema.TaggedError<LabIssue>()("LabIssue", {
  message: Schema.String,
}) {}
export type LabResult =
  | { readonly kind: "success"; readonly receipt: string }
  | { readonly kind: "uncertain"; readonly message: string }
  | { readonly kind: "cancelled" }
export type LabPorts = {
  run: (request: LabRequest) => Effect.Effect<LabResult, LabIssue, Scope.Scope>
  check: (
    request: LabRequest
  ) => Effect.Effect<LabResult, LabIssue, Scope.Scope>
  cancel: (request: LabRequest) => Effect.Effect<void>
}
export type LabCompletion = {
  readonly id: string
  readonly generation: number
  readonly exit: Exit.Exit<LabResult, LabIssue>
}
const contextSchema = Schema.Struct({
  generation: Schema.Number,
  sequence: Schema.Number,
  request: Schema.NullOr(LabRequest),
  mode: Schema.Literals(["run", "check"]),
  intent: Schema.Literals(["finish", "cancel", "reset"]),
  availability: Schema.Literals(["enabled", "disabled"]),
  receipt: Schema.String,
  error: Schema.String,
  failure: Schema.Unknown,
})
export type LabContext = typeof contextSchema.Type
const initialContext: LabContext = {
  generation: 0,
  sequence: 0,
  request: null,
  mode: "run",
  intent: "finish",
  availability: "enabled",
  receipt: "",
  error: "",
  failure: null,
}
function resetContext(context: LabContext): LabContext {
  return {
    ...initialContext,
    generation: context.generation + 1,
    sequence: context.sequence,
  }
}
function retryAllowed(context: LabContext) {
  return (
    context.availability === "enabled" &&
    context.request !== null &&
    (!Cause.isCause(context.failure) ||
      (!Cause.hasDies(context.failure) &&
        !Cause.hasInterrupts(context.failure)))
  )
}

/** Results belong to an immutable request. Cleanup finishes before this result
 * can release an active slot; reset/cancel never start a second invocation. */
export function applyLabCompletion(context: LabContext, result: LabCompletion) {
  if (
    result.id !== context.request?.id ||
    result.generation !== context.request.generation
  )
    return
  if (
    Exit.isFailure(result.exit) &&
    (Cause.hasDies(result.exit.cause) || Cause.hasInterrupts(result.exit.cause))
  )
    return {
      target: "#primitive-lab.task.error",
      context: {
        ...context,
        error: "The simulation stopped unexpectedly. Reset to start again.",
        failure: result.exit.cause,
      },
    }
  if (context.intent === "reset")
    return {
      target: "#primitive-lab.task.idle",
      context: resetContext(context),
    }
  if (context.intent === "cancel")
    return {
      target: "#primitive-lab.task.cancelled",
      context: { ...context, error: "", failure: null },
    }
  if (Exit.isFailure(result.exit)) {
    const reason = result.exit.cause.reasons.find(
      (value) => value._tag === "Fail"
    )
    return {
      target: "#primitive-lab.task.error",
      context: {
        ...context,
        error:
          reason?._tag === "Fail"
            ? reason.error.message
            : "The simulation stopped unexpectedly. Reset to start again.",
        failure: result.exit.cause,
      },
    }
  }
  const value = result.exit.value
  return value.kind === "success"
    ? {
        target: "#primitive-lab.task.success",
        context: {
          ...context,
          receipt: value.receipt,
          error: "",
          failure: null,
        },
      }
    : value.kind === "uncertain"
      ? {
          target: "#primitive-lab.task.uncertain",
          context: { ...context, error: value.message, failure: null },
        }
      : {
          target: "#primitive-lab.task.cancelled",
          context: { ...context, error: "", failure: null },
        }
}

/** A local component laboratory, with no backend or application authority.
 * Pointer and focus are independent dimensions; task progression owns work. */
export function labMachine(ports: LabPorts) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: contextSchema,
      events: {
        START: Schema.Struct({ scenario: LabScenario, delayMs: delay }),
        RETRY: Schema.Struct({}),
        CHECK: Schema.Struct({}),
        CANCEL: Schema.Struct({}),
        RESET: Schema.Struct({}),
        ENABLE: Schema.Struct({}),
        DISABLE: Schema.Struct({}),
        POINTER_ENTER: Schema.Struct({}),
        POINTER_LEAVE: Schema.Struct({}),
        POINTER_DOWN: Schema.Struct({}),
        POINTER_UP: Schema.Struct({}),
        FOCUS: Schema.Struct({}),
        BLUR: Schema.Struct({}),
      },
    },
    actors: {
      work: createEffectLogic(
        ({
          input,
        }: {
          input: { request: LabRequest; mode: "run" | "check" }
        }) =>
          Effect.exit(
            Effect.scoped(
              input.mode === "run"
                ? ports.run(input.request)
                : ports.check(input.request)
            )
          ).pipe(
            Effect.map((exit): LabCompletion => ({
              id: input.request.id,
              generation: input.request.generation,
              exit,
            }))
          )
      ),
    },
    actions: {
      abort: ({ params }: { params?: unknown }) =>
        ports.cancel(Schema.decodeUnknownSync(LabRequest)(params)),
    },
  }).createMachine({
    id: "primitive-lab",
    type: "parallel",
    context: initialContext,
    on: {
      ENABLE: ({ context }) => ({
        context: { ...context, availability: "enabled" },
      }),
      DISABLE: ({ context }) => ({
        context: { ...context, availability: "disabled" },
      }),
    },
    states: {
      task: {
        initial: "idle",
        on: {
          RESET: ({ context }) => ({
            target: ".idle",
            context: resetContext(context),
          }),
        },
        states: {
          idle: {
            on: {
              START: ({ context, event }) =>
                context.availability === "enabled"
                  ? {
                      target: "active",
                      context: {
                        ...context,
                        sequence: context.sequence + 1,
                        mode: "run",
                        intent: "finish",
                        error: "",
                        receipt: "",
                        failure: null,
                        request: {
                          id: `lab-${context.generation}-${context.sequence + 1}`,
                          generation: context.generation,
                          scenario: event.scenario,
                          delayMs: event.delayMs,
                        },
                      },
                    }
                  : {},
            },
          },
          active: {
            initial: "loading",
            invoke: {
              id: "lab-work",
              src: "work",
              input: ({ context }) => ({
                request: context.request!,
                mode: context.mode,
              }),
              onDone: ({ context, event }) =>
                applyLabCompletion(context, event.output),
            },
            on: {
              RESET: (args, enq) => {
                enq(args.actions.abort, {
                  ...args,
                  params: args.context.request,
                })
                return {
                  target: ".resetting",
                  context: { ...args.context, intent: "reset" },
                }
              },
            },
            states: {
              loading: {
                on: {
                  CANCEL: (args, enq) => {
                    enq(args.actions.abort, {
                      ...args,
                      params: args.context.request,
                    })
                    return {
                      target: "cancelling",
                      context: { ...args.context, intent: "cancel" },
                    }
                  },
                },
              },
              cancelling: {},
              resetting: {},
            },
          },
          success: {},
          error: {
            on: {
              RETRY: ({ context }) =>
                retryAllowed(context)
                  ? {
                      target: "active",
                      context: {
                        ...context,
                        mode: "run",
                        intent: "finish",
                        error: "",
                        failure: null,
                      },
                    }
                  : {},
            },
          },
          uncertain: {
            on: {
              CHECK: ({ context }) =>
                context.availability === "enabled"
                  ? {
                      target: "active",
                      context: {
                        ...context,
                        mode: "check",
                        intent: "finish",
                        error: "",
                      },
                    }
                  : {},
            },
          },
          cancelled: {},
        },
      },
      pointer: {
        initial: "idle",
        on: { RESET: { target: ".idle" }, POINTER_LEAVE: { target: ".idle" } },
        states: {
          idle: {
            on: {
              POINTER_ENTER: { target: "hover" },
              POINTER_DOWN: ({ context }) =>
                context.availability === "enabled" ? { target: "pressed" } : {},
            },
          },
          hover: {
            on: {
              POINTER_DOWN: ({ context }) =>
                context.availability === "enabled" ? { target: "pressed" } : {},
            },
          },
          pressed: {
            on: {
              POINTER_UP: { target: "hover" },
              DISABLE: ({ context }) => ({
                target: "idle",
                context: { ...context, availability: "disabled" },
              }),
            },
          },
        },
      },
      focus: {
        initial: "blurred",
        on: { RESET: { target: ".blurred" } },
        states: {
          blurred: { on: { FOCUS: { target: "focused" } } },
          focused: { on: { BLUR: { target: "blurred" } } },
        },
      },
    },
  })
}
export type LabMachine = ReturnType<typeof labMachine>
export type LabEvent = EventFromLogic<LabMachine>
export type LabSnapshot = SnapshotFrom<LabMachine>
export type LabStatus =
  | "idle"
  | "loading"
  | "success"
  | "error"
  | "uncertain"
  | "cancelled"
export function labStatus(snapshot?: LabSnapshot): LabStatus {
  if (!snapshot) return "idle"
  if (snapshot.matches({ task: "active" })) return "loading"
  for (const status of ["success", "error", "uncertain", "cancelled"] as const)
    if (snapshot.matches({ task: status })) return status
  return "idle"
}
export function labView(snapshot?: LabSnapshot) {
  const status = labStatus(snapshot)
  const busy = status === "loading"
  return {
    status,
    busy,
    ready: !!snapshot,
    disabled: !snapshot || busy || snapshot.context.availability === "disabled",
    hovered: !!snapshot && !snapshot.matches({ pointer: "idle" }),
    pressed: !!snapshot?.matches({ pointer: "pressed" }),
    focused: !!snapshot?.matches({ focus: "focused" }),
    error: snapshot?.context.error ?? "",
    receipt: snapshot?.context.receipt ?? "",
    attempt: snapshot?.context.request ?? null,
  }
}

function leafPaths(value: StateValue, prefix = ""): readonly string[] {
  return typeof value === "string"
    ? [`${prefix}${value}`]
    : Object.entries(value).flatMap(([key, child]) =>
        child === undefined ? [] : leafPaths(child, `${prefix}${key}.`)
      )
}
function dimensions(state: LabSnapshot) {
  return [
    ...leafPaths(state.value),
    `availability.${state.context.availability}`,
  ]
}

/** Bounded data examples feed the real transition functions. This is a pure
 * graph traversal: no actor is started and no Effect work is executed. IDs and
 * counters do not create different legal states in this local demonstration. */
function projectLabGraph() {
  const machine = labMachine({
    run: () => Effect.never,
    check: () => Effect.never,
    cancel: () => Effect.void,
  })
  const controls: readonly LabEvent[] = [
    { type: "START", scenario: "success", delayMs: 10 },
    { type: "RETRY" },
    { type: "CHECK" },
    { type: "CANCEL" },
    { type: "RESET" },
    { type: "ENABLE" },
    { type: "DISABLE" },
    { type: "POINTER_ENTER" },
    { type: "POINTER_LEAVE" },
    { type: "POINTER_DOWN" },
    { type: "POINTER_UP" },
    { type: "FOCUS" },
    { type: "BLUR" },
  ]
  const graph = getAdjacencyMap(machine, {
    events: (state) => [
      ...controls,
      ...(state.matches({ task: "active" }) && state.context.request
        ? [
            Exit.succeed({ kind: "success", receipt: "example" } as const),
            Exit.succeed({
              kind: "uncertain",
              message: "Check status",
            } as const),
            Exit.succeed({ kind: "cancelled" } as const),
            Exit.fail(new LabIssue({ message: "Rejected" })),
          ].map((exit) => ({
            type: "xstate.done.actor" as const,
            actorId: "lab-work",
            output: {
              id: state.context.request!.id,
              generation: state.context.request!.generation,
              exit,
            },
          }))
        : []),
    ],
    serializeState: (state) =>
      JSON.stringify({
        value: state.value,
        availability: state.context.availability,
        mode: state.context.mode,
        intent: state.context.intent,
      }),
    limit: 10_000,
  })
  const states = new Set<string>()
  const edges = new Map<
    string,
    Readonly<{ from: string; event: string; to: string }>
  >()
  for (const { state, event, nextState } of adjacencyMapToArray(graph)) {
    const before = dimensions(state),
      after = dimensions(nextState)
    for (const path of [...before, ...after]) states.add(path)
    for (const from of before) {
      const to = after.find((path) => path.split(".")[0] === from.split(".")[0])
      if (!to || from === to) continue
      const edge = Object.freeze({ from, event: event.type, to })
      edges.set(JSON.stringify(edge), edge)
    }
  }
  return {
    states: Object.freeze([...states].sort()),
    edges: Object.freeze([...edges.values()]),
  }
}
const labGraph = projectLabGraph()
/** Reachable state dimensions, derived from labMachine rather than a second model. */
export const labStates = labGraph.states
/** Legal state-changing edges; guards still govern each concrete event. */
export const labEdges = labGraph.edges
