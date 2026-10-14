import type { Context } from "@earendil-works/chord"
import { Effect } from "effect"
import {
  GenerationTask,
  hook,
  type HookApi,
  type Storage,
} from "@earendil-works/pi-durable"
import type { AccessStore } from "../../access/adapters/sqlite"
import {
  recoveryFingerprint,
  RunBlocked,
  type Observation,
  type RecoveryView,
} from "../recovery"
import type { RunRecoveryStore } from "./sqlite-recovery"

export type RecoverySource = { turnId: string; steeringKey: string }
export function runRecoveryHook(options: {
  storage: Storage
  store: RunRecoveryStore
  access: AccessStore
  source: (api: HookApi) => RecoverySource | undefined
  stop: (api: HookApi, context: Context) => Promise<void>
  observed?: (turnId: string, view: RecoveryView) => void
  changed?: () => void
}) {
  const { storage, store, access, source } = options
  return hook(GenerationTask, {
    beforeRequest: async ({ messages }, api, context) => {
      const origin = source(api)
      if (!origin) return { messages }
      const epoch = await Effect.runPromise(
        Effect.tryPromise(() => recoveryFingerprint(origin.steeringKey)),
        { signal: context.abortSignal }
      )
      if (source(api)?.steeringKey !== origin.steeringKey) return { messages }
      await api.memo("recovery:epoch", epoch, context)
      if (source(api)?.steeringKey !== origin.steeringKey) return { messages }
      const state = store.observe(
        origin.turnId,
        String(api.conversationId),
        epoch,
        epoch,
        []
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
        let outcome: Observation["outcome"] = "ignored"
        let category = "tool_error"
        if (receipt && ["running", "interrupted"].includes(receipt.status))
          outcome = "uncertain"
        else if (receipt && ["denied", "expired"].includes(receipt.status))
          outcome = "denied"
        else if (
          receipt &&
          ["pending", "approved", "cancelled"].includes(receipt.status)
        )
          outcome = "ignored"
        else if (codes.includes("interrupted")) outcome = "uncertain"
        else if (codes.includes("blocked")) outcome = "denied"
        else if (codes.includes("aborted")) outcome = "ignored"
        else if (result.isError) {
          if (
            !receipt &&
            access
              .policies()
              .some(
                (policy) => policy.name === call.name && policy.mode === "deny"
              )
          )
            outcome = "denied"
          else {
            outcome = "failure"
            category = codes.includes("invalid_arguments")
              ? "invalid_arguments"
              : codes.includes("tool_unavailable")
                ? "tool_unavailable"
                : "tool_error"
          }
        } else outcome = call.name === "check_bot_task" ? "poll" : "success"
        observations.push({
          resultId: Number(id),
          invocation:
            entry.byTaskId === undefined
              ? `entry:${id}`
              : `task:${entry.byTaskId}:${result.toolCallId}`,
          tool: /^[a-zA-Z0-9_.:-]{1,160}$/.test(call.name)
            ? call.name
            : "unavailable_tool",
          fingerprint: await recoveryFingerprint({
            tool: call.name,
            args: receipt ? JSON.parse(receipt.input) : call.arguments,
            category,
          }),
          outcome,
          receiptId: receipt?.id ?? null,
        })
      }
      const epoch = await recoveryFingerprint(origin.steeringKey)
      const requestEpoch = await api.memo<string>("recovery:epoch", context)
      const current = source(api)
      if (!current || current.turnId !== origin.turnId) return
      const changedDuringRead = current.steeringKey !== origin.steeringKey
      const previousPhase = store.get(origin.turnId)?.view?.phase
      const state = store.observe(
        origin.turnId,
        String(api.conversationId),
        epoch,
        changedDuringRead ? "stale-request" : (requestEpoch ?? epoch),
        observations
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
