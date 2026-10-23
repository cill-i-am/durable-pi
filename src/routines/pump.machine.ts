import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import type { Turn } from "../conversations/turns"
import type { RoutineRun } from "./contracts"

export interface RoutinePumpContext<E> {
  run: RoutineRun | undefined
  turn: Pick<Turn, "id" | "status" | "error"> | undefined
  allowDispatch: boolean
  eligible: boolean
  connected: boolean
  deadline: number
  delivered: boolean
  outcome: Exit.Exit<number | undefined, E>
}
export type RoutinePumpStage =
  | "discover"
  | "observe"
  | "finish"
  | "stop"
  | "claim"
  | "model"
  | "arm"
  | "authority"
  | "deliver"
  | "wake"
  | "notify"
  | "schedule"
export type RoutinePumpWork<E> = Record<
  RoutinePumpStage,
  (context: RoutinePumpContext<E>) => Effect.Effect<RoutinePumpContext<E>, E>
>

/** Local observation and handoff only; Conversations/Pi retain admitted work. */
export function routinePumpMachine<E>(
  work: RoutinePumpWork<E>,
  allowDispatch = true
) {
  type C = RoutinePumpContext<E>
  const contextSchema = Schema.declare(
    (value): value is C =>
      typeof value === "object" &&
      value !== null &&
      "outcome" in value &&
      Exit.isExit(value.outcome)
  )
  const outcome = Schema.declare(
    (value): value is Exit.Exit<number | undefined, E> => Exit.isExit(value)
  )
  const stage = (name: RoutinePumpStage) =>
    createEffectLogic(({ input }: { input: C }) =>
      Effect.exit(Effect.suspend(() => work[name](input)))
    )
  const input = ({ context }: { context: C }) => context
  const advance =
    (route: string | ((context: C) => string)) =>
    ({ context, event }: { context: C; event: { output: Exit.Exit<C, E> } }) =>
      Exit.isFailure(event.output)
        ? {
            target: "settled",
            context: {
              ...context,
              outcome: Exit.failCause(event.output.cause),
            },
          }
        : {
            target:
              typeof route === "string" ? route : route(event.output.value),
            context: event.output.value,
          }
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: { context: contextSchema, output: outcome },
    actors: {
      discover: stage("discover"),
      observe: stage("observe"),
      finish: stage("finish"),
      stop: stage("stop"),
      claim: stage("claim"),
      model: stage("model"),
      arm: stage("arm"),
      authority: stage("authority"),
      deliver: stage("deliver"),
      wake: stage("wake"),
      notify: stage("notify"),
      schedule: stage("schedule"),
    },
  }).createMachine({
    id: "routine-pump",
    initial: "discovering",
    context: (): C => ({
      allowDispatch,
      run: undefined,
      turn: undefined,
      eligible: false,
      connected: false,
      deadline: 0,
      delivered: false,
      outcome: Exit.succeed(undefined),
    }),
    output: ({ context }) => context.outcome,
    states: {
      discovering: {
        invoke: {
          src: "discover",
          input,
          onDone: advance((c) =>
            !c.eligible
              ? "settled"
              : c.run && c.run.status !== "pending"
                ? "observing"
                : c.allowDispatch
                  ? "claiming"
                  : "settled"
          ),
        },
      },
      observing: {
        invoke: {
          src: "observe",
          input,
          onDone: advance((c) =>
            !c.turn || ["done", "failed", "cancelled"].includes(c.turn.status)
              ? "finishing"
              : c.run?.status === "stopping"
                ? "stopping"
                : c.allowDispatch
                  ? "claiming"
                  : "scheduling"
          ),
        },
      },
      finishing: {
        invoke: {
          src: "finish",
          input,
          onDone: advance((c) => (c.allowDispatch ? "claiming" : "scheduling")),
        },
      },
      stopping: {
        invoke: { src: "stop", input, onDone: advance("wakingStop") },
      },
      wakingStop: {
        invoke: {
          src: "wake",
          input,
          onDone: advance((c) => (c.allowDispatch ? "claiming" : "scheduling")),
        },
      },
      claiming: {
        invoke: {
          src: "claim",
          input,
          onDone: advance((c) =>
            c.run?.status === "pending" ? "checkingModel" : "scheduling"
          ),
        },
      },
      checkingModel: {
        invoke: {
          src: "model",
          input,
          onDone: advance((c) => (c.connected ? "arming" : "scheduling")),
        },
      },
      arming: {
        invoke: { src: "arm", input, onDone: advance("checkingAuthority") },
      },
      checkingAuthority: {
        invoke: {
          src: "authority",
          input,
          onDone: advance((c) =>
            c.allowDispatch ? "delivering" : "notifying"
          ),
        },
      },
      delivering: {
        invoke: {
          src: "deliver",
          input,
          onDone: advance((c) => (c.delivered ? "waking" : "notifying")),
        },
      },
      waking: { invoke: { src: "wake", input, onDone: advance("notifying") } },
      notifying: {
        invoke: { src: "notify", input, onDone: advance("scheduling") },
      },
      scheduling: {
        invoke: { src: "schedule", input, onDone: advance("settled") },
      },
      settled: { type: "final" },
    },
  })
}
