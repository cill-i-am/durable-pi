import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import type { ConversationObservation } from "./execution"
import { canSubmitInput } from "./input.machine"
import type { RecoveryView } from "./recovery"
import type { Turn } from "./turns"

export type ConversationControlMode = "automatic" | "inspect" | "stop"
export type ConversationControlPhase = "handoff" | "observe" | "stop"
export interface ConversationPumpContext<E> {
  turn: Turn | undefined
  members: readonly Turn[]
  index: number
  allowed: boolean
  ready: boolean
  before: string
  reply: ConversationObservation | undefined
  recovery: RecoveryView | undefined
  preparationError: string | undefined
  stopping: boolean
  abortingRecovery: boolean
  reconcileHandoff: boolean
  wake: number | undefined
  outcome: Exit.Exit<number | undefined, E>
}
export const pumpTurn = <E>(context: ConversationPumpContext<E>): Turn => {
  if (!context.turn) throw new Error("Conversation pump has no claimed turn")
  return context.turn
}
export type ConversationPumpStage =
  | "prepareRuntime"
  | "claim"
  | "check"
  | "requestStop"
  | "members"
  | "prepareFile"
  | "refresh"
  | "prepareRoot"
  | "prompt"
  | "session"
  | "configure"
  | "wakeCompaction"
  | "submit"
  | "submitted"
  | "watermark"
  | "steer"
  | "steered"
  | "recovery"
  | "cancelAccess"
  | "abort"
  | "cancelPlan"
  | "delegation"
  | "observe"
  | "archive"
  | "memoryChanged"
  | "wakeBackup"
  | "awaitingAccess"
  | "complete"
  | "completed"
  | "wakeBackground"
  | "schedule"
export type ConversationPumpWork<E> = {
  [K in ConversationPumpStage]: (
    context: ConversationPumpContext<E>
  ) => Effect.Effect<ConversationPumpContext<E>, E>
}

/** Each invocation is one bounded control operation. Pi owns the durable run;
 * this scoped actor owns only ordering, current authority and local handles. */
export function conversationPumpMachine<E>(
  work: ConversationPumpWork<E>,
  mode: ConversationControlMode,
  observeFailure: <A>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>
) {
  type C = ConversationPumpContext<E>
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
  const stage = (name: ConversationPumpStage) =>
    createEffectLogic(({ input }: { input: C }) =>
      Effect.exit(observeFailure(Effect.suspend(() => work[name](input))))
    )
  const advance =
    (next: string | ((context: C) => { target: string; context?: C })) =>
    ({
      context,
      event,
    }: {
      context: C
      event: { output: Exit.Exit<C, E> }
    }) => {
      if (Exit.isFailure(event.output))
        return {
          target: "settled",
          context: { ...context, outcome: Exit.failCause(event.output.cause) },
        }
      const updated = event.output.value
      return typeof next === "string"
        ? { target: next, context: updated }
        : { context: updated, ...next(updated) }
    }
  const input = ({ context }: { context: C }) => context
  const later = (context: C, wake: number) => ({
    target: "scheduling",
    context: { ...context, wake },
  })
  const route = (context: C) => {
    const turn = pumpTurn(context)
    if (
      mode === "inspect" ||
      turn.status === "running" ||
      turn.status === "stopping"
    )
      return { target: "capturingWatermark" }
    if (!canSubmitInput(turn)) return later(context, 10)
    return {
      target: turn.status === "queued" ? "preparingRoot" : "pinningPrompt",
    }
  }
  const selectSteer = (context: C): { target: string; context?: C } => {
    if (
      mode !== "automatic" ||
      pumpTurn(context).status !== "running" ||
      context.preparationError
    )
      return { target: "refreshingObservation" }
    const index = context.members.findIndex(
      (member, index) =>
        index >= context.index &&
        member.id !== pumpTurn(context).id &&
        member.status === "queued"
    )
    return index === -1
      ? { target: "refreshingObservation" }
      : { target: "reconcilingSteer", context: { ...context, index } }
  }
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: { context: contextSchema, output: outcome },
    actors: {
      prepareRuntime: stage("prepareRuntime"),
      claim: stage("claim"),
      check: stage("check"),
      requestStop: stage("requestStop"),
      members: stage("members"),
      prepareFile: stage("prepareFile"),
      refresh: stage("refresh"),
      prepareRoot: stage("prepareRoot"),
      prompt: stage("prompt"),
      session: stage("session"),
      configure: stage("configure"),
      wakeCompaction: stage("wakeCompaction"),
      submit: stage("submit"),
      submitted: stage("submitted"),
      watermark: stage("watermark"),
      steer: stage("steer"),
      steered: stage("steered"),
      recovery: stage("recovery"),
      cancelAccess: stage("cancelAccess"),
      abort: stage("abort"),
      cancelPlan: stage("cancelPlan"),
      delegation: stage("delegation"),
      observe: stage("observe"),
      archive: stage("archive"),
      memoryChanged: stage("memoryChanged"),
      wakeBackup: stage("wakeBackup"),
      awaitingAccess: stage("awaitingAccess"),
      complete: stage("complete"),
      completed: stage("completed"),
      wakeBackground: stage("wakeBackground"),
      schedule: stage("schedule"),
    },
  }).createMachine({
    id: "conversation-pump",
    context: (): C => ({
      turn: undefined,
      members: [],
      index: 0,
      allowed: false,
      ready: false,
      before: "",
      reply: undefined,
      recovery: undefined,
      preparationError: undefined,
      stopping: false,
      abortingRecovery: false,
      reconcileHandoff: false,
      wake: undefined,
      outcome: Exit.succeed(undefined),
    }),
    output: ({ context }) => context.outcome,
    initial: "claiming",
    states: {
      claiming: {
        invoke: {
          src: "claim",
          input,
          onDone: advance((c) =>
            !c.turn
              ? { target: "settled" }
              : {
                  target:
                    mode === "stop" ? "requestingStop" : "checkingAuthority",
                }
          ),
        },
      },
      checkingAuthority: {
        invoke: {
          src: "check",
          input,
          onDone: advance((c) =>
            mode === "inspect"
              ? route(c)
              : !c.allowed
                ? { target: "requestingStop" }
                : pumpTurn(c).status === "stopping"
                  ? route(c)
                  : { target: "preparingRuntime" }
          ),
        },
      },
      preparingRuntime: {
        invoke: {
          src: "prepareRuntime",
          input,
          onDone: advance("checkingRuntime"),
        },
      },
      checkingRuntime: {
        invoke: {
          src: "check",
          input,
          onDone: advance((c) =>
            !c.allowed
              ? { target: "requestingStop" }
              : pumpTurn(c).status === "stopping"
                ? route(c)
                : { target: "readingFiles" }
          ),
        },
      },
      requestingStop: {
        invoke: {
          src: "requestStop",
          input,
          onDone: advance("capturingWatermark"),
        },
      },
      readingFiles: {
        invoke: {
          src: "members",
          input,
          onDone: advance((c) => ({
            target: "selectingFile",
            context: { ...c, index: 0 },
          })),
        },
      },
      selectingFile: {
        always: ({ context }) => {
          const index = context.members.findIndex(
            (member, index) => index >= context.index && member.files_pending
          )
          return index === -1
            ? { target: "refreshingPreparation" }
            : { target: "preparingFile", context: { ...context, index } }
        },
      },
      preparingFile: {
        invoke: {
          src: "prepareFile",
          input,
          onDone: advance((c) =>
            c.preparationError
              ? { target: "capturingWatermark" }
              : !c.ready
                ? later(c, 5000)
                : {
                    target: "selectingFile",
                    context: { ...c, index: c.index + 1 },
                  }
          ),
        },
      },
      refreshingPreparation: {
        invoke: { src: "refresh", input, onDone: advance(route) },
      },
      preparingRoot: {
        invoke: { src: "prepareRoot", input, onDone: advance("pinningPrompt") },
      },
      pinningPrompt: {
        invoke: {
          src: "prompt",
          input,
          onDone: advance((c) =>
            !pumpTurn(c).prompt ? later(c, 10) : { target: "bindingSession" }
          ),
        },
      },
      bindingSession: {
        invoke: {
          src: "session",
          input,
          onDone: advance((c) => ({
            target: c.reconcileHandoff
              ? "reconcilingHandoff"
              : "checkingConfiguration",
          })),
        },
      },
      reconcilingHandoff: {
        invoke: {
          src: "observe",
          input,
          onDone: advance((c) => ({
            target: c.reply?.accepted?.includes(pumpTurn(c).id)
              ? "recordingSubmission"
              : "checkingConfiguration",
          })),
        },
      },
      checkingConfiguration: {
        invoke: {
          src: "check",
          input,
          onDone: advance((c) =>
            !c.allowed
              ? { target: "requestingStop" }
              : !canSubmitInput(pumpTurn(c))
                ? later(c, 10)
                : { target: "configuring" }
          ),
        },
      },
      configuring: {
        invoke: {
          src: "configure",
          input,
          onDone: advance("wakingBeforeSubmit"),
        },
      },
      wakingBeforeSubmit: {
        invoke: {
          src: "wakeCompaction",
          input,
          onDone: advance("checkingSubmission"),
        },
      },
      checkingSubmission: {
        invoke: {
          src: "check",
          input,
          onDone: advance((c) =>
            !c.allowed
              ? { target: "requestingStop" }
              : !canSubmitInput(pumpTurn(c))
                ? later(c, 10)
                : { target: "submitting" }
          ),
        },
      },
      submitting: {
        invoke: {
          src: "submit",
          input,
          onDone: advance("recordingSubmission"),
        },
      },
      recordingSubmission: {
        invoke: {
          src: "submitted",
          input,
          onDone: advance((c) => later(c, 100)),
        },
      },
      capturingWatermark: {
        invoke: { src: "watermark", input, onDone: advance("readingMembers") },
      },
      readingMembers: {
        invoke: {
          src: "members",
          input,
          onDone: advance((c) => selectSteer({ ...c, index: 0 })),
        },
      },
      reconcilingSteer: {
        invoke: {
          src: "observe",
          input,
          onDone: advance((c) => ({
            target: c.reply?.accepted?.includes(c.members[c.index]!.id)
              ? "recordingSteer"
              : "checkingSteer",
          })),
        },
      },
      checkingSteer: {
        invoke: {
          src: "check",
          input,
          onDone: advance((c) =>
            !c.allowed
              ? { target: "requestingStop" }
              : pumpTurn(c).status !== "running"
                ? { target: "refreshingObservation" }
                : { target: "steering" }
          ),
        },
      },
      steering: {
        invoke: { src: "steer", input, onDone: advance("recordingSteer") },
      },
      recordingSteer: {
        invoke: {
          src: "steered",
          input,
          onDone: advance((c) => selectSteer({ ...c, index: c.index + 1 })),
        },
      },
      refreshingObservation: {
        invoke: {
          src: "refresh",
          input,
          onDone: advance((c) => {
            const stopping =
              mode !== "inspect" &&
              (pumpTurn(c).status === "stopping" || !!c.preparationError)
            return {
              target: stopping ? "cancellingAccess" : "readingRecovery",
              context: { ...c, stopping },
            }
          }),
        },
      },
      cancellingAccess: {
        invoke: { src: "cancelAccess", input, onDone: advance("aborting") },
      },
      aborting: {
        invoke: {
          src: "abort",
          input,
          onDone: advance((c) => ({
            target: c.abortingRecovery
              ? "selectingDelegation"
              : "cancellingPlan",
          })),
        },
      },
      cancellingPlan: {
        invoke: {
          src: "cancelPlan",
          input,
          onDone: advance("readingRecovery"),
        },
      },
      readingRecovery: {
        invoke: {
          src: "recovery",
          input,
          onDone: advance((c) =>
            mode !== "inspect" &&
            !c.stopping &&
            pumpTurn(c).status === "running" &&
            c.recovery?.phase === "blocked"
              ? {
                  target: "aborting",
                  context: { ...c, abortingRecovery: true },
                }
              : { target: "selectingDelegation" }
          ),
        },
      },
      selectingDelegation: {
        always: ({ context }) => ({
          target:
            mode !== "inspect" && pumpTurn(context).status === "running"
              ? "reconcilingDelegation"
              : "observing",
        }),
      },
      reconcilingDelegation: {
        invoke: { src: "delegation", input, onDone: advance("observing") },
      },
      observing: {
        invoke: { src: "observe", input, onDone: advance("archiving") },
      },
      archiving: {
        invoke: { src: "archive", input, onDone: advance("checkingMemory") },
      },
      checkingMemory: {
        invoke: {
          src: "memoryChanged",
          input,
          onDone: advance((c) => ({
            target: c.ready ? "wakingChangedCompaction" : "checkingCompletion",
          })),
        },
      },
      wakingChangedCompaction: {
        invoke: {
          src: "wakeCompaction",
          input,
          onDone: advance("wakingChangedBackup"),
        },
      },
      wakingChangedBackup: {
        invoke: {
          src: "wakeBackup",
          input,
          onDone: advance("checkingCompletion"),
        },
      },
      checkingCompletion: {
        invoke: {
          src: "check",
          input,
          onDone: advance((c) => {
            if (mode === "inspect" && !c.allowed) return { target: "settled" }
            if (!c.allowed && pumpTurn(c).status !== "stopping")
              return { target: "requestingStop" }
            if (!c.ready) return later(c, 10)
            if (mode === "inspect" && !c.reply?.settled)
              return { target: "settled" }
            return {
              target:
                c.reply && !c.reply.settled ? "waitingForNative" : "completing",
            }
          }),
        },
      },
      waitingForNative: {
        invoke: {
          src: "awaitingAccess",
          input,
          onDone: advance((c) => later(c, c.ready ? 30_000 : 150)),
        },
      },
      completing: {
        invoke: {
          src: "complete",
          input,
          onDone: advance((c) =>
            c.ready ? { target: "publishingCompletion" } : later(c, 10)
          ),
        },
      },
      publishingCompletion: {
        invoke: {
          src: "completed",
          input,
          onDone: advance("wakingBackground"),
        },
      },
      wakingBackground: {
        invoke: {
          src: "wakeBackground",
          input,
          onDone: advance("closingAccess"),
        },
      },
      closingAccess: {
        invoke: {
          src: "cancelAccess",
          input,
          onDone: advance("wakingFinalCompaction"),
        },
      },
      wakingFinalCompaction: {
        invoke: {
          src: "wakeCompaction",
          input,
          onDone: advance("wakingFinalBackup"),
        },
      },
      wakingFinalBackup: {
        invoke: {
          src: "wakeBackup",
          input,
          onDone: advance((c) => later(c, 10)),
        },
      },
      scheduling: {
        invoke: { src: "schedule", input, onDone: advance("settled") },
      },
      settled: { type: "final" },
    },
  })
}
