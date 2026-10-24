import { createEffectActor, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Equal, Schema, type Scope } from "effect"

import { CodeRun, RunHistory } from "@/execution/contracts"
import { agentApi } from "@/http/client"
import { orDieAll } from "@/shared/effect"
import { nativeOperation } from "@/shared/interop"

import {
  executionMachine,
  type ExecutionView,
  type ExecutionWork,
} from "./execution.machine"

export function executionRequests(
  agentId: string
): Pick<ExecutionWork, "read" | "command"> {
  const request = (path: string, body?: unknown) =>
    nativeOperation(
      (signal) => agentApi(agentId)(path, body, signal),
      (cause) => cause
    )
  return {
    read: (view) =>
      Effect.gen(function* () {
        const history = Schema.decodeUnknownSync(RunHistory)(
          yield* request("execution")
        )
        const detail = view.selected
          ? Schema.decodeUnknownSync(CodeRun)(
              yield* request(`execution/${encodeURIComponent(view.selected)}`)
            )
          : null
        return { runs: history.runs, detail }
      }),
    command: (command) =>
      request(
        command.kind === "run"
          ? "execution/run"
          : `execution/${encodeURIComponent(command.id)}/cancel`,
        command.kind === "run" ? command.input : {}
      ).pipe(
        Effect.map(
          Schema.decodeUnknownSync(
            CodeRun.check(
              Schema.makeFilter(
                (run) =>
                  run.id ===
                    (command.kind === "run" ? command.input.id : command.id) ||
                  "The response belongs to a different run."
              )
            )
          )
        )
      ),
  }
}

/** The component owns both scopes; observer cancellation never cancels a backend run. */
export function makeExecutionOwner(view: ExecutionView, work: ExecutionWork) {
  return Effect.gen(function* () {
    const failures: Cause.Cause<unknown>[] = []
    let actor: EffectActor<ReturnType<typeof executionMachine>> | undefined
    const observe = <A>(operation: Effect.Effect<A, unknown, Scope.Scope>) =>
      operation.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (exit._tag === "Failure" && Cause.hasDies(exit.cause))
              failures.push(exit.cause)
          })
        )
      )
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => {
        const retained = actor?.getSnapshot().context.failure
        const reasons = failures
          .flatMap((failure) => failure.reasons)
          .filter(
            (reason) =>
              !(
                Cause.isCause(retained) &&
                retained.reasons.some((present) =>
                  Equal.equals(present, reason)
                )
              )
          )
        return reasons.length
          ? Effect.failCause(Cause.fromReasons(reasons)).pipe(orDieAll)
          : Effect.void
      })
    )
    actor = yield* createEffectActor(
      executionMachine({
        read: (input) => observe(work.read(input)),
        command: (input) => observe(work.command(input)),
        select: work.select,
      }),
      { input: view }
    )
    return actor
  })
}
