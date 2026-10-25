import { Deferred, Effect } from "effect"

import {
  LabIssue,
  type LabPorts,
  type LabRequest,
  type LabResult,
} from "./lab.machine"

/** Per-mounted-story resources. No network, storage, random delays or automatic retry. */
export function makeLabSimulation() {
  return Effect.sync(() => {
    const active = new Map<string, Deferred.Deferred<void>>()
    const cancelled = new Set<string>()
    const calls = new Map<string, number>()
    const ledger = new Map<string, string>()
    const trace: string[] = []
    const perform = (request: LabRequest) =>
      Effect.gen(function* () {
        const count = (calls.get(request.id) ?? 0) + 1
        calls.set(request.id, count)
        yield* Effect.sleep(request.delayMs)
        if (request.scenario === "hold") return yield* Effect.never
        if (request.scenario === "error" && count === 1)
          return yield* new LabIssue({
            message:
              "The simulated save failed. Retry the same request or reset.",
          })
        const receipt = ledger.get(request.id) ?? `receipt:${request.id}`
        ledger.set(request.id, receipt)
        trace.push(`committed:${request.id}`)
        return request.scenario === "uncertain"
          ? ({
              kind: "uncertain",
              message:
                "The save may have completed. Check its status before trying again.",
            } as const)
          : ({ kind: "success", receipt } as const)
      })
    const execute = (
      request: LabRequest,
      body: Effect.Effect<LabResult, LabIssue>
    ) =>
      Effect.acquireUseRelease(
        Deferred.make<void>().pipe(
          Effect.tap((gate) =>
            Effect.sync(() => {
              active.set(request.id, gate)
              trace.push(`started:${request.id}`)
            })
          )
        ),
        (gate) =>
          Effect.gen(function* () {
            if (cancelled.has(request.id))
              yield* Deferred.succeed(gate, undefined)
            return yield* Effect.raceFirst(
              body,
              Deferred.await(gate).pipe(
                Effect.as({ kind: "cancelled" } as const)
              )
            )
          }),
        () =>
          Effect.sync(() => {
            active.delete(request.id)
            cancelled.delete(request.id)
            trace.push(`released:${request.id}`)
          })
      )
    const ports: LabPorts = {
      run: (request) => execute(request, perform(request)),
      check: (request) =>
        execute(
          request,
          Effect.sleep(request.delayMs).pipe(
            Effect.andThen(
              Effect.sync((): LabResult => {
                const receipt = ledger.get(request.id)
                trace.push(`checked:${request.id}`)
                return receipt
                  ? { kind: "success", receipt }
                  : {
                      kind: "uncertain",
                      message:
                        "The result is still unknown. Check again or reset the example.",
                    }
              })
            )
          )
        ),
      cancel: (request) =>
        Effect.suspend(() => {
          cancelled.add(request.id)
          const gate = active.get(request.id)
          return gate
            ? Deferred.succeed(gate, undefined).pipe(Effect.asVoid)
            : Effect.void
        }),
    }
    return {
      ports,
      trace,
      activeCount: () => active.size,
      receiptCount: () => ledger.size,
    }
  })
}
