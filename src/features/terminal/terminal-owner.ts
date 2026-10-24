import { createEffectActor, send, type EffectActor } from "@xstate/effect"
import { Deferred, Effect, Schema } from "effect"

import { agentApi } from "@/http/client"
import { nativeOperation } from "@/shared/interop"
import { CommandRun, TerminalState } from "@/terminal/contracts"

import { terminalWorkFailures } from "./owned-work"
import {
  terminalUiMachine,
  type TerminalIntent,
  type TerminalWork,
} from "./terminal-ui.machine"

export type TerminalActor = EffectActor<ReturnType<typeof terminalUiMachine>>
export function terminalRequests(agentId: string): TerminalWork {
  const request = (path: string, body?: unknown) =>
    nativeOperation(
      (signal) => agentApi(agentId)(path, body, signal),
      (cause) => cause
    )
  return {
    read: (selected) =>
      Effect.gen(function* () {
        const history = Schema.decodeUnknownSync(TerminalState)(
          yield* request("terminal")
        )
        const run = selected
          ? Schema.decodeUnknownSync(CommandRun)(
              yield* request(`terminal/${encodeURIComponent(selected)}`)
            )
          : null
        return { history, run }
      }),
    command: (input) =>
      request(input.path, input.body).pipe(
        Effect.map((result) => ({
          history:
            input.kind === "network"
              ? Schema.decodeUnknownSync(TerminalState)(result)
              : null,
          run:
            input.kind === "run"
              ? Schema.decodeUnknownSync(CommandRun)(result)
              : null,
        }))
      ),
  }
}
export function makeTerminalOwner(
  input: { agentId: string; selected: string | null; visible: boolean },
  work: TerminalWork
) {
  return Effect.gen(function* () {
    const observe = yield* terminalWorkFailures
    const actor = yield* createEffectActor(
      terminalUiMachine({
        read: (selected) => observe(work.read(selected)),
        command: (request) => observe(work.command(request)),
      }),
      { input }
    )
    return actor
  })
}
export function terminalCommand(actor: TerminalActor, intent: TerminalIntent) {
  return Effect.gen(function* () {
    if (actor.getSnapshot().status !== "active") return false
    const ticket = crypto.randomUUID(),
      result = yield* Deferred.make<boolean>()
    const settle = (ok: boolean) => Effect.runSync(Deferred.succeed(result, ok))
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        actor.on("settled", (event) => {
          if (event.ticket === ticket) settle(event.ok)
        })
      ),
      (subscription) => Effect.sync(() => subscription.unsubscribe())
    )
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        actor.subscribe({
          complete: () => settle(false),
          error: () => settle(false),
        })
      ),
      (subscription) => Effect.sync(() => subscription.unsubscribe())
    )
    yield* send(actor, { type: "COMMAND", ticket, intent })
    return yield* Deferred.await(result)
  }).pipe(Effect.scoped)
}
