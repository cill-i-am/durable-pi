import { createEffectActor, send, waitFor } from "@xstate/effect"
import { Deferred, Effect } from "effect"

import type { AgentProfile } from "@/agents/contracts"

import { agentCatalogMachine } from "./agent-catalog.machine"
import { makeAgentRequests } from "./agent-requests"

export function makeAgentCatalog(
  read: (signal: AbortSignal) => Promise<readonly AgentProfile[]>
) {
  return Effect.gen(function* () {
    const requests = yield* makeAgentRequests()
    const pending = new Set<Deferred.Deferred<void, unknown>>()
    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        pending,
        (reply) => Deferred.fail(reply, new Error("Agent catalog closed.")),
        { discard: true }
      )
    )
    const actor = yield* createEffectActor(
      agentCatalogMachine(requests.request(read))
    )
    return {
      actor,
      revoke: requests.revoke,
      refresh: () =>
        Effect.gen(function* () {
          if (!requests.active() || actor.getSnapshot().status !== "active")
            return yield* Effect.fail(new Error("Agent catalog closed."))
          const reply = yield* Deferred.make<void, unknown>()
          pending.add(reply)
          return yield* send(actor, { type: "REFRESH", reply }).pipe(
            Effect.andThen(
              Effect.raceFirst(
                Deferred.await(reply),
                waitFor(actor, (state) => state.status !== "active").pipe(
                  Effect.andThen(
                    Effect.fail(new Error("Agent catalog closed."))
                  )
                )
              )
            ),
            Effect.ensuring(Effect.sync(() => pending.delete(reply)))
          )
        }),
    }
  })
}
