import type { Context } from "@earendil-works/chord"
import {
  GenerationTask,
  hook,
  type HookApi,
  type Storage,
} from "@earendil-works/pi-durable"
import { Cause, Effect } from "effect"

import type { AccessLedger } from "../../access/ledger"
import type { AgentStorageError } from "../../agents/domain"
import type { RoutineStorageError } from "../../routines/persistence"
import { nativeOperation } from "../../shared/interop"
import {
  recoveryOutcome,
  type Observation,
  type RecoveryView,
} from "../recovery"
import {
  makeRunRecovery,
  runRecoveryHookProgram,
  type RecoveryHookWork,
  type RecoveryHashError,
  type RecoverySource,
  type RecoveryLedger,
  type RunRecovery,
} from "../recovery-service"
import { ConversationStorageError } from "../turns"
import { webCryptoRecoveryFingerprint } from "./crypto"

export type { RecoverySource } from "../recovery-service"
export function runRecoveryHook(options: {
  storage: Storage
  store: RecoveryLedger
  application?: typeof RunRecovery.Service
  run?: <TValue, TError>(
    program: Effect.Effect<TValue, TError>,
    options?: { signal?: AbortSignal }
  ) => Promise<TValue>
  access: Pick<AccessLedger, "get" | "policies">
  source: (
    api: HookApi
  ) => Effect.Effect<
    RecoverySource | undefined,
    AgentStorageError | RoutineStorageError | ConversationStorageError
  >
  stop: (api: HookApi, context: Context) => Promise<void>
  observed?: (turnId: string, view: RecoveryView) => void
  changed?: () => void
}) {
  const { storage, store, access } = options
  const checked = <TValue, TError>(
    operation: string,
    work: Effect.Effect<TValue, TError>
  ) =>
    Effect.catchCause(work, (cause) =>
      Effect.failCause(
        Cause.map(
          cause,
          (error) => new ConversationStorageError({ operation, cause: error })
        )
      )
    )
  const source = (api: HookApi) =>
    checked("read recovery authority", options.source(api))
  const app =
    options.application ?? makeRunRecovery(store, webCryptoRecoveryFingerprint)
  const run = options.run ?? Effect.runPromise
  const native = <A>(operation: string, work: () => Promise<A>) =>
    nativeOperation(
      work,
      (cause) => new ConversationStorageError({ operation, cause })
    )
  function roundObservations(
    assistantId: Parameters<Storage["entry"]>[1],
    results: readonly Parameters<Storage["entry"]>[1][],
    api: HookApi,
    context: Context,
    origin: RecoverySource
  ) {
    return Effect.gen(function* () {
      const assistant = (yield* native("read native assistant entry", () =>
        storage.entry(api.conversationId, assistantId, context)
      ))?.entry
      const message = assistant?.model?.[0]
      if (assistant?.kind !== "pi.assistant" || message?.role !== "assistant")
        throw new Error("Recovery requires a native assistant entry")
      const calls = message.content.filter((part) => part.type === "toolCall")
      return yield* Effect.forEach(results, (id) =>
        Effect.gen(function* () {
          const entry = (yield* native("read native tool result", () =>
            storage.entry(api.conversationId, id, context)
          ))?.entry
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
              : yield* checked(
                  "read recovery receipt",
                  access.get(String(entry.byTaskId))
                )
          if (
            receipt &&
            (receipt.turnId !== origin.turnId || receipt.tool !== call.name)
          )
            throw new Error("Recovery receipt ownership mismatch")
          const codes = diagnosticCodes(entry.data)
          const { outcome, category } = recoveryOutcome({
            receiptStatus: receipt?.status,
            diagnostics: codes,
            isError: result.isError,
            tool: call.name,
            deniedPolicy:
              !receipt &&
              result.isError &&
              (yield* checked("read recovery policy", access.policies())).some(
                (policy) => policy.name === call.name && policy.mode === "deny"
              ),
          })
          return {
            resultId: Number(id),
            invocation: recoveryInvocation(
              entry.byTaskId,
              id,
              result.toolCallId
            ),
            tool: /^[a-zA-Z0-9_.:-]{1,160}$/.test(call.name)
              ? call.name
              : "unavailable_tool",
            fingerprint: yield* app.epoch({
              tool: call.name,
              args: receipt
                ? (JSON.parse(receipt.input) as unknown)
                : call.arguments,
              category,
            }),
            outcome,
            receiptId: receipt?.id ?? null,
          }
        })
      )
    })
  }
  const program = (
    kind: "before" | "after",
    api: HookApi,
    context: Context,
    collect: (
      origin: RecoverySource
    ) => Effect.Effect<
      readonly Observation[],
      ConversationStorageError | RecoveryHashError
    >
  ) => {
    const work: RecoveryHookWork<ConversationStorageError | RecoveryHashError> =
      {
        kind,
        source: Effect.suspend(() => source(api)),
        collect,
        hash: (key) => app.epoch(key),
        remember: (epoch) =>
          native("save native recovery epoch", () =>
            api.memo("recovery:epoch", epoch, context)
          ),
        recall: native("read native recovery epoch", () =>
          api.memo<string>("recovery:epoch", context)
        ),
        read: (id) => app.get(id),
        commit: ({ origin, epoch, requestEpoch, observations }) =>
          app.observe(
            origin.turnId,
            String(api.conversationId),
            epoch,
            requestEpoch,
            observations,
            () =>
              source(api).pipe(
                Effect.map((latest) => {
                  if (latest?.turnId !== origin.turnId) return undefined
                  if (kind === "before")
                    return latest.steeringKey === origin.steeringKey
                      ? epoch
                      : undefined
                  return latest.steeringKey === origin.steeringKey
                    ? requestEpoch
                    : "stale-request"
                })
              )
          ),
        publish: ({ origin, state, previousPhase }) =>
          Effect.sync(() => {
            if (state?.view && state.view.phase !== previousPhase) {
              try {
                options.observed?.(origin.turnId, state.view)
              } catch {}
            }
            options.changed?.()
          }),
        // The exact native call context must reach abort(). Its signal lets Pi
        // escape waiting for its own GenerationTask while the stop is committed.
        stop: native("stop blocked native generation", () =>
          options.stop(api, context)
        ),
      }
    return run(runRecoveryHookProgram(work), { signal: context.abortSignal })
  }
  return hook(GenerationTask, {
    beforeRequest: async ({ messages }, api, context) => {
      const state = await program("before", api, context, () =>
        Effect.succeed([])
      )
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
      await program("after", api, context, (origin) =>
        roundObservations(assistantId, results, api, context, origin)
      )
    },
  })
}

function diagnosticCodes(data: unknown): string[] {
  const diagnostics =
    data && typeof data === "object" && !Array.isArray(data)
      ? "diagnostics" in data
        ? data.diagnostics
        : undefined
      : undefined
  const codes = Array.isArray(diagnostics)
    ? diagnostics.flatMap((value: unknown) =>
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        "code" in value &&
        typeof value.code === "string"
          ? [value.code]
          : []
      )
    : []
  return codes
}

function recoveryInvocation(
  taskId: unknown,
  entryId: unknown,
  toolCallId: string
) {
  return taskId === undefined
    ? `entry:${entryId}`
    : `task:${taskId}:${toolCallId}`
}
