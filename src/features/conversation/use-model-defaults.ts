import { useQueryClient } from "@tanstack/react-query"
import { Cause, Effect, Exit, Fiber } from "effect"
import { useEffect, useRef, useState } from "react"
import type { SnapshotFrom } from "xstate"

import type { ModelSelection, ModelSettings } from "@/conversations/turns"
import { agentApi } from "@/http/client"
import type { ModelCatalogResponse } from "@/inference/catalog-api"
import { resolveRoute, validateRoute } from "@/inference/policy"

import { makeModelDefaults } from "./model-defaults-owner"
import type { modelDefaultsMachine } from "./model-defaults.machine"
import { modelQuery } from "./model-query"
import { useModelCatalog } from "./use-model-catalog"

export type ModelDefaultsProps = {
  agentId: string
  selection: ModelSelection
  onModelAccess?: () => void
  onSaved: () => void
  onPendingChange: (pending: boolean) => void
}
export function useModelDefaults(
  props: ModelDefaultsProps,
  currentAgent: () => string
) {
  const { agentId, selection, onPendingChange } = props
  const query = useModelCatalog(agentId, selection.settingsRevision)
  const client = useQueryClient()
  const initial = useRef({ agentId, selection })
  const latest = useRef({ props, query })
  latest.current = { props, query }
  const owner = useRef<Effect.Success<
    ReturnType<typeof makeModelDefaults>
  > | null>(null)
  const [snapshot, setSnapshot] = useState<SnapshotFrom<
    ReturnType<typeof modelDefaultsMachine>
  > | null>(null)
  useEffect(() => {
    let mounted = true
    const key = modelQuery.getQueryKey({ query: { agent: agentId } })
    const currentCatalog = () => {
      const state = client.getQueryState<ModelCatalogResponse>(key)
      if (state?.status === "error") throw state.error
      if (!state?.data)
        throw new Error(
          "Could not verify model availability. Refresh to retry."
        )
      return state.data
    }
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (currentAgent() === agentId)
              latest.current.props.onPendingChange(false)
          })
        )
        const value = yield* makeModelDefaults(initial.current, {
          authorized: () => mounted && currentAgent() === agentId,
          cancel: () => latest.current.query.cancel(),
          write: (attempt, signal) => {
            validateRoute(attempt.draft, currentCatalog())
            return agentApi(attempt.agentId)(
              "settings",
              { ...attempt.draft, job: attempt.job },
              signal
            )
          },
          acknowledge: (attempt, confirmed) => {
            latest.current.query.setCatalog((current) =>
              current &&
              current.selection.settingsRevision <= confirmed.settingsRevision
                ? {
                    ...current,
                    selection: confirmed,
                    assignments: {
                      ...current.assignments,
                      [attempt.job]: resolveRoute(attempt.job, attempt.draft),
                    },
                  }
                : current
            )
            latest.current.props.onSaved()
          },
          refresh: async () => {
            await latest.current.query.refresh()
            return currentCatalog()
          },
        })
        owner.current = value
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            value.actor.subscribe((state) => {
              if (mounted) setSnapshot(state)
            })
          ),
          (subscription) => Effect.sync(() => subscription.unsubscribe())
        )
        if (mounted) setSnapshot(value.actor.getSnapshot())
        return yield* Effect.never
      }).pipe(Effect.scoped)
    )
    return () => {
      mounted = false
      owner.current?.revoke()
      owner.current = null
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
    // The owner belongs to this keyed agent. Live callbacks and SDK projection
    // are capabilities read through latest; their identity does not restart work.
  }, [agentId, client, currentAgent])
  const context = snapshot?.context
  const job = context?.job ?? "conversation"
  const initialized = snapshot !== null
  useEffect(() => {
    const draft =
      query.catalog?.assignments[job] ??
      (job === "conversation"
        ? { model: selection.model, thinking: selection.thinking }
        : resolveRoute(job))
    void owner.current?.actor.send({
      type: "SOURCE",
      job,
      draft,
      settingsRevision:
        query.catalog?.selection.settingsRevision ?? selection.settingsRevision,
    })
  }, [
    query.catalog,
    initialized,
    job,
    selection.model,
    selection.thinking,
    selection.settingsRevision,
  ])
  const busy =
    !snapshot ||
    (!snapshot.matches("ready") && !snapshot.matches("unconfirmed"))
  const unconfirmed = !!snapshot?.matches("unconfirmed")
  const dirty = context?.dirty ?? false
  useEffect(() => {
    onPendingChange(dirty || busy || unconfirmed)
  }, [dirty, busy, unconfirmed, onPendingChange])
  return {
    ...query,
    job,
    draft: context?.draft ?? selection,
    dirty,
    busy,
    unconfirmed,
    saved: context?.saved ?? false,
    error: context?.error ?? "",
    change: (draft: ModelSettings) =>
      owner.current?.actor.send({ type: "CHANGE", draft }),
    event: (
      event: Parameters<NonNullable<typeof owner.current>["actor"]["send"]>[0]
    ) => owner.current?.actor.send(event),
  }
}
