import { send, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Exit, Fiber } from "effect"
import { useEffect, useMemo, useState } from "react"
import type { EventFromLogic, SnapshotFrom } from "xstate"

import { authClient } from "@/auth/client"
import { agentApi } from "@/http/client"

import { makeChannelSettings } from "./settings-owner"
import { settingsRequests } from "./settings-request"
import {
  type Channel,
  type SettingsChange,
  type channelSettingsMachine,
} from "./settings.machine"

type Machine = ReturnType<typeof channelSettingsMachine>
export function useChannelSettings(
  channel: Channel,
  agentId: string,
  archived: boolean,
  open: boolean,
  onPendingChange: (pending: boolean) => void
) {
  const { data: session } = authClient.useSession()
  const owner = session?.user.id
  const api = useMemo(() => agentApi(agentId), [agentId])
  const [actor, setActor] = useState<EffectActor<Machine> | null>(null)
  const [snapshot, setSnapshot] = useState<SnapshotFrom<Machine> | null>(null)
  useEffect(() => {
    if (!owner) return
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const owned = yield* makeChannelSettings(
          { channel, archived, open },
          settingsRequests(
            channel,
            owner,
            agentId,
            sessionStorage,
            api,
            () => document.visibilityState === "visible",
            channel === "whatsapp"
              ? (target, path, body, signal) =>
                  agentApi(target)(path, body, signal)
              : undefined
          )
        )
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            owned.subscribe((value) => {
              if (mounted) setSnapshot(value)
            })
          ),
          (subscription) => Effect.sync(() => subscription.unsubscribe())
        )
        if (mounted) {
          setActor(owned)
          setSnapshot(owned.getSnapshot())
        }
        return yield* Effect.never
      }).pipe(Effect.scoped)
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
    // Authority changes enter the current actor without restarting owned work.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [api, owner, agentId, channel])
  useEffect(() => {
    if (actor)
      Effect.runFork(send(actor, { type: "AUTHORITY", archived, open }))
  }, [actor, archived, open])
  const busy =
    !snapshot || snapshot.matches("restoring") || snapshot.matches("changing")
  const confirming = snapshot?.matches("confirming") === true
  const attempt = snapshot?.context.request ?? null
  useEffect(() => {
    onPendingChange(busy || !!attempt)
    return () => onPendingChange(false)
  }, [busy, attempt, onPendingChange])
  const dispatch = (event: EventFromLogic<Machine>) => {
    if (actor) Effect.runFork(send(actor, event))
  }
  return {
    view: snapshot?.context.view ?? null,
    error: snapshot?.context.error ?? "",
    busy,
    attempt: confirming ? null : attempt,
    resend: confirming && attempt?.path === "retry" ? attempt.body.id : null,
    change: (request: SettingsChange) => dispatch({ type: "CHANGE", request }),
    refresh: () => dispatch({ type: "REFRESH" }),
    retrySame: () => dispatch({ type: "RETRY" }),
    confirm: () => dispatch({ type: "CONFIRM" }),
    cancel: () => dispatch({ type: "CANCEL" }),
    setError: (message: string) => dispatch({ type: "ERROR", message }),
  }
}
