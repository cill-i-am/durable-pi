import type { Context } from "@earendil-works/chord"
import { Schema, Effect } from "effect"
import {
  GenerationTask,
  hook,
  type HookApi,
  type Storage,
} from "@earendil-works/pi-durable"
import type { AccessLedger } from "../../access/ledger"
import { AgentStorageError } from "../../agents/domain"
import { RoutineStorageError } from "../../routines/persistence"
import { ConversationStorageError } from "../turns"
import {
  recoveryOutcome,
  RunBlocked,
  type Observation,
  type RecoveryView,
} from "../recovery"
import {
  makeRunRecovery,
  type RecoveryLedger,
  type RunRecovery,
} from "../recovery-service"
import { webCryptoRecoveryFingerprint } from "./crypto"

export type RecoverySource = { turnId: string; steeringKey: string }
export function runRecoveryHook(options: {
  storage: Storage
  store: RecoveryLedger
  application?: typeof RunRecovery.Service
  run?: <TValue, TError>(
    program: Effect.Effect<TValue, TError>,
    options?: { signal?: AbortSignal }
  ) => Promise<TValue>
  access: Pick<AccessLedger, "get" | "policies">
  source: (api: HookApi) => RecoverySource | undefined
  stop: (api: HookApi, context: Context) => Promise<void>
  observed?: (turnId: string, view: RecoveryView) => void
  changed?: () => void
}) {
  const { storage, store, access } = options
  const source = (api: HookApi) => {
    try {
      return options.source(api)
    } catch (cause) {
      const knownFailure = Schema.decodeUnknownOption(
        Schema.Union([AgentStorageError, RoutineStorageError])
      )(cause)
      if (knownFailure._tag === "Some")
        throw new ConversationStorageError({
          operation: "read recovery authority",
          cause: knownFailure.value,
        })
      throw cause
    }
  }
  const app =
    options.application ?? makeRunRecovery(store, webCryptoRecoveryFingerprint)
  const run = options.run ?? Effect.runPromise
  const fingerprint = (value: unknown, context: Context) =>
    run(app.epoch(value), { signal: context.abortSignal })
  return hook(GenerationTask, {
    beforeRequest: async ({ messages }, api, context) => {
      const origin = source(api)
      if (!origin) return { messages }
      const epoch = await fingerprint(origin.steeringKey, context)
      if (source(api)?.steeringKey !== origin.steeringKey) return { messages }
      await api.memo("recovery:epoch", epoch, context)
      if (source(api)?.steeringKey !== origin.steeringKey) return { messages }
      const state = await run(
        app.observe(
          origin.turnId,
          String(api.conversationId),
          epoch,
          epoch,
          [],
          () => {
            const current = source(api)
            return current?.turnId === origin.turnId &&
              current.steeringKey === origin.steeringKey
              ? epoch
              : undefined
          }
        ),
        { signal: context.abortSignal }
      )
      if (state?.view?.phase === "blocked") {
        await options.stop(api, context)
        throw new RunBlocked({ message: state.view.detail })
      }
      if (state?.view?.phase !== "recovering") return { messages }
      const text = `Run recovery: ${state.view.tool} failed ${state.view.failures} times with the same inputs (saved result ${state.view.resultId}). ${state.view.remaining} attempts remain. Inspect that error; correct inputs or use a permitted approach. Never bypass access or repeat uncertain effects.`
      return {
        messages: [
          ...messages,
          {
            role: "user" as const,
            timestamp: Date.now(),
            content: [{ type: "text" as const, text }],
          },
        ],
      }
    },
    afterTools: async (assistantId, results, api, context) => {
      const origin = source(api)
      if (!origin) return
      const assistant = (
        await storage.entry(api.conversationId, assistantId, context)
      )?.entry
      const message = assistant?.model?.[0]
      if (assistant?.kind !== "pi.assistant" || message?.role !== "assistant")
        throw new Error("Recovery requires a native assistant entry")
      const calls = message.content.filter((part) => part.type === "toolCall")
      const observations: Observation[] = []
      for (const id of results) {
        const entry = (await storage.entry(api.conversationId, id, context))
          ?.entry
        const result = entry?.model?.[0]
        if (entry?.kind !== "pi.tool-result" || result?.role !== "toolResult")
          throw new Error("Recovery requires a native tool result")
        const call = calls.find(
          (candidate) => candidate.id === result.toolCallId
        )
        if (!call) throw new Error("Recovery tool/result pairing is missing")
        const receipt =
          entry.byTaskId === undefined
            ? undefined
            : access.get(String(entry.byTaskId))
        if (
          receipt &&
          (receipt.turnId !== origin.turnId || receipt.tool !== call.name)
        )
          throw new Error("Recovery receipt ownership mismatch")
        const diagnostics =
          entry.data &&
          typeof entry.data === "object" &&
          !Array.isArray(entry.data)
            ? entry.data.diagnostics
            : undefined
        const codes = Array.isArray(diagnostics)
          ? diagnostics.flatMap((value) =>
              value &&
              typeof value === "object" &&
              !Array.isArray(value) &&
              typeof value.code === "string"
                ? [value.code]
                : []
            )
          : []
        const { outcome, category } = recoveryOutcome({
          receiptStatus: receipt?.status,
          diagnostics: codes,
          isError: result.isError,
          tool: call.name,
          deniedPolicy:
            !receipt &&
            result.isError &&
            access
              .policies()
              .some(
                (policy) => policy.name === call.name && policy.mode === "deny"
              ),
        })
        observations.push({
          resultId: Number(id),
          invocation:
            entry.byTaskId === undefined
              ? `entry:${id}`
              : `task:${entry.byTaskId}:${result.toolCallId}`,
          tool: /^[a-zA-Z0-9_.:-]{1,160}$/.test(call.name)
            ? call.name
            : "unavailable_tool",
          fingerprint: await fingerprint(
            {
              tool: call.name,
              args: receipt ? JSON.parse(receipt.input) : call.arguments,
              category,
            },
            context
          ),
          outcome,
          receiptId: receipt?.id ?? null,
        })
      }
      const epoch = await fingerprint(origin.steeringKey, context)
      const requestEpoch = await api.memo<string>("recovery:epoch", context)
      const current = source(api)
      if (!current || current.turnId !== origin.turnId) return
      const previousPhase = (
        await run(app.get(origin.turnId), { signal: context.abortSignal })
      )?.view?.phase
      const state = await run(
        app.observe(
          origin.turnId,
          String(api.conversationId),
          epoch,
          requestEpoch ?? epoch,
          observations,
          () => {
            const latest = source(api)
            return latest?.turnId === origin.turnId
              ? latest.steeringKey !== origin.steeringKey
                ? "stale-request"
                : (requestEpoch ?? epoch)
              : undefined
          }
        ),
        { signal: context.abortSignal }
      )
      if (state?.view && state.view.phase !== previousPhase) {
        try {
          options.observed?.(origin.turnId, state.view)
        } catch {}
      }
      options.changed?.()
      if (state?.view?.phase === "blocked") {
        await options.stop(api, context)
        throw new RunBlocked({ message: state.view.detail })
      }
    },
  })
}
