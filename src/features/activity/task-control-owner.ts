import { createEffectActor } from "@xstate/effect"
import { Cause, Effect, Schema, type Scope } from "effect"

import { Control } from "@/delegation/contracts"
import { orDieAll } from "@/shared/effect"

import { confirmedRejection, controlKey } from "./delegation-commands"
import { activityJsonRequest, activityQueryRequest } from "./query-owner"
import {
  BackgroundCommand,
  commandAction,
  commandMatches,
  taskControlMachine,
  type TaskCommand,
  type TaskControlView,
  type TaskControlWork,
} from "./task-control.machine"

const recoveryError = (message: string) =>
  Object.assign(new Error(message), {
    _tag: "ActivityControlRecoveryError" as const,
  })
const isRecoveryError = Schema.is(
  Schema.Struct({
    _tag: Schema.Literal("ActivityControlRecoveryError"),
    message: Schema.String,
  })
)

export function taskCommandKey(
  view: TaskControlView,
  action: "stop" | "steer" | "retry"
) {
  return view.childId === null
    ? `background-command:${view.agentId}:${view.groupId}:${action}`
    : `${view.prefix === "background" ? "background:" : ""}${controlKey(view.agentId, view.groupId, view.childId, action as "stop" | "steer")}`
}
export function taskControlRequests(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  uuid: () => string = () => crypto.randomUUID()
): TaskControlWork {
  const read = (view: TaskControlView): readonly TaskCommand[] => {
    const actions =
      view.childId === null
        ? (["stop", "retry"] as const)
        : (["stop", "steer"] as const)
    return actions.flatMap((action) => {
      const raw = storage.getItem(taskCommandKey(view, action))
      if (!raw) return []
      const value: unknown = JSON.parse(raw)
      if (
        typeof value === "object" &&
        value !== null &&
        ("schemaVersion" in value || "workflowVersion" in value)
      )
        throw recoveryError(
          "This saved control requires a compatible application version. Its recovery record has been retained."
        )
      const command: TaskCommand =
        view.childId === null
          ? {
              kind: "background",
              body: Schema.decodeUnknownSync(BackgroundCommand, {
                onExcessProperty: "error",
              })(value),
            }
          : {
              kind: "child",
              body: Schema.decodeUnknownSync(Control, {
                onExcessProperty: "error",
              })(value),
            }
      if (!commandMatches(view, command) || commandAction(command) !== action)
        throw recoveryError(
          "Saved control does not match this task. Its recovery record has been retained."
        )
      return [command]
    })
  }
  const clear = (view: TaskControlView, command: TaskCommand) => {
    const current = read(view).find(
      (value) => commandAction(value) === commandAction(command)
    )
    if (current?.body.operationId === command.body.operationId)
      storage.removeItem(taskCommandKey(view, commandAction(command)))
  }
  const storageWork = <A>(work: () => A) =>
    Effect.try({
      try: work,
      catch: (cause) =>
        isRecoveryError(cause)
          ? cause
          : new Error(
              "The saved action could not be read or updated. Its recovery record has been retained; reopen activity after browser storage is available."
            ),
    })
  const rejected = (cause: Cause.Cause<unknown>) =>
    !Cause.hasDies(cause) &&
    !Cause.hasInterrupts(cause) &&
    cause.reasons.every(
      (reason) => reason._tag === "Fail" && confirmedRejection(reason.error)
    )
  return {
    restore: (view) => storageWork(() => read(view)),
    prepare: (view, intent, saved) =>
      storageWork(() => {
        const stored = read(view),
          current = stored.find(
            (command) => commandAction(command) === intent.action
          )
        if (
          current &&
          saved &&
          current.body.operationId !== saved.body.operationId
        )
          throw new Error("Saved control changed.")
        if (!current && !saved && stored.length && intent.action !== "stop")
          throw new Error("Another saved control is awaiting acknowledgement.")
        const command: TaskCommand =
          current ??
          saved ??
          (view.childId === null
            ? {
                kind: "background",
                body: {
                  groupId: view.groupId,
                  operationId: uuid(),
                  action: intent.action as "stop" | "retry",
                },
              }
            : {
                kind: "child",
                body: {
                  groupId: view.groupId,
                  childId: view.childId,
                  operationId: uuid(),
                  action:
                    intent.action === "stop"
                      ? { type: "stop" }
                      : { type: "steer", text: intent.text },
                },
              })
        const decoded = Schema.decodeUnknownSync(
          view.childId === null ? BackgroundCommand : Control
        )(command.body)
        storage.setItem(
          taskCommandKey(view, intent.action),
          JSON.stringify(decoded)
        )
        return command
      }),
    submit: (view, command) =>
      Effect.gen(function* () {
        const request = activityQueryRequest((signal) =>
          activityJsonRequest(
            view.agentId,
            command.kind === "background"
              ? `background/${command.body.action}`
              : `${view.prefix}/control`,
            signal,
            command.kind === "background"
              ? {
                  groupId: command.body.groupId,
                  operationId: command.body.operationId,
                }
              : command.body
          )
        )
        yield* request.pipe(
          Effect.catchCause((cause) =>
            rejected(cause)
              ? storageWork(() => clear(view, command)).pipe(
                  Effect.andThen(Effect.failCause(cause))
                )
              : Effect.failCause(cause)
          )
        )
        yield* storageWork(() => clear(view, command))
      }),
    rejected,
  }
}
export function makeTaskControlOwner(
  view: TaskControlView,
  work: TaskControlWork
) {
  return Effect.gen(function* () {
    const failures: Cause.Cause<unknown>[] = []
    const observe = <A>(effect: Effect.Effect<A, unknown, Scope.Scope>) =>
      effect.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (
              exit._tag === "Failure" &&
              (Cause.hasDies(exit.cause) ||
                (Cause.hasInterrupts(exit.cause) &&
                  exit.cause.reasons.some((reason) => reason._tag === "Fail")))
            )
              failures.push(exit.cause)
          })
        )
      )
    // Snapshot context only projects a failure; it does not propagate that
    // failure to the parent scope. Keep each fatal observation until close.
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() =>
        failures.length
          ? Effect.failCause(
              Cause.fromReasons(failures.flatMap((cause) => cause.reasons))
            ).pipe(orDieAll)
          : Effect.void
      )
    )
    return yield* createEffectActor(
      taskControlMachine({
        restore: (view) => observe(work.restore(view)),
        prepare: (view, intent, saved) =>
          observe(work.prepare(view, intent, saved)),
        submit: (view, command) => observe(work.submit(view, command)),
        rejected: work.rejected,
      }),
      { input: view }
    )
  })
}
