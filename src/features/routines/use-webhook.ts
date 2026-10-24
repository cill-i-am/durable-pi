import { send, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Exit, Fiber } from "effect"
import { useEffect, useState } from "react"
import type { EventFromLogic, SnapshotFrom } from "xstate"

import type { ConfigureWebhook } from "@/webhooks/contracts"

import { makeWebhookOwner, webhookRequests } from "./webhook-owner"
import type { webhookUiMachine } from "./webhook-ui.machine"

type Machine = ReturnType<typeof webhookUiMachine>
export function useWebhook(
  agentId: string,
  routineId: string,
  onPendingChange: (value: boolean) => void
) {
  const key = `${agentId}:${routineId}`
  const [owner, setOwner] = useState<{
    key: string
    actor: EffectActor<Machine>
  } | null>(null)
  const [state, setState] = useState<{
    key: string
    snapshot: SnapshotFrom<Machine>
  } | null>(null)
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          const actor = yield* makeWebhookOwner(
            routineId,
            webhookRequests(agentId, routineId)
          )
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              actor.subscribe((snapshot) => {
                if (mounted) setState({ key, snapshot })
              })
            ),
            (subscription) => Effect.sync(() => subscription.unsubscribe())
          )
          if (mounted) {
            setOwner({ key, actor })
            setState({ key, snapshot: actor.getSnapshot() })
          }
          return yield* Effect.never
        })
      )
    )
    return () => {
      mounted = false
      Effect.runFork(
        Fiber.interrupt(fiber).pipe(
          Effect.andThen(Fiber.await(fiber)),
          Effect.flatMap((exit) =>
            Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
              ? Effect.logError(exit.cause)
              : Effect.void
          )
        )
      )
    }
  }, [agentId, routineId, key])
  const actor = owner?.key === key ? owner.actor : null
  const snapshot = state?.key === key ? state.snapshot : null
  const busy =
    !snapshot ||
    snapshot.matches("loading") ||
    snapshot.matches("submitting") ||
    snapshot.matches("resolving")
  const attempt = snapshot?.context.attempt ?? null
  const pending = !!attempt
  useEffect(() => {
    onPendingChange(pending)
    return () => onPendingChange(false)
  }, [pending, onPendingChange])
  const dispatch = (event: EventFromLogic<Machine>) =>
    actor ? Effect.runPromise(send(actor, event)) : Promise.resolve()
  return {
    info: snapshot?.context.info ?? null,
    attempt,
    busy,
    key: snapshot?.context.key ?? null,
    error: snapshot?.context.error ?? "",
    message: snapshot?.context.message ?? "",
    send: (change: ConfigureWebhook) => dispatch({ type: "SEND", change }),
    resolve: () => dispatch({ type: "RESOLVE" }),
    retry: () => dispatch({ type: "RETRY" }),
    refresh: () => dispatch({ type: "REFRESH" }),
  }
}
