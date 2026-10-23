import { send, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Exit, Fiber } from "effect"
import { useEffect, useMemo, useState } from "react"
import type { SnapshotFrom } from "xstate"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import type { CompactionRecovery } from "@/conversations/contracts"
import { agentApi } from "@/http/client"
import type { SummaryIssue } from "@/memory/domain"
import { nativeOperation } from "@/shared/interop"

import { makeSummaryRecovery } from "./summary-recovery-owner"
import {
  currentRecoveryRequest,
  recoveryRequestKey,
  type summaryRecoveryMachine,
  type SummaryRecoveryRequest,
  type SummaryRecoveryView,
} from "./summary-recovery.machine"

type Machine = ReturnType<typeof summaryRecoveryMachine>
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">

export function requestSummaryRecovery(
  post: (path: string, body: unknown, signal: AbortSignal) => Promise<unknown>,
  storage: Storage,
  agentId: string,
  request: SummaryRecoveryRequest,
  operationId: () => string = () => crypto.randomUUID()
) {
  if (request.kind === "scheduler")
    return nativeOperation(
      (signal) =>
        post("memory/retry_compaction", { epoch: request.epoch }, signal),
      (cause) => cause
    ).pipe(Effect.asVoid)
  return Effect.gen(function* () {
    const key = `memory-retry:${agentId}:${request.start}+${request.count}`
    const id = yield* Effect.try({
      try: () => {
        const id = storage.getItem(key) ?? operationId()
        storage.setItem(key, id)
        return id
      },
      catch: (cause) => cause,
    })
    yield* nativeOperation(
      (signal) =>
        post(
          "memory/retry",
          {
            start: request.start,
            count: request.count,
            operationId: id,
          },
          signal
        ),
      (cause) => cause
    )
    yield* Effect.try({
      try: () => {
        if (storage.getItem(key) === id) storage.removeItem(key)
      },
      catch: (cause) => cause,
    })
  })
}

function recoveryError(
  view: SummaryRecoveryView,
  snapshot: SnapshotFrom<Machine> | null
) {
  const request = snapshot?.context.request
  const outcome = snapshot?.context.outcome
  if (
    !request ||
    !currentRecoveryRequest(view, request) ||
    !outcome ||
    !Exit.isFailure(outcome)
  )
    return null
  const failed = outcome.cause.reasons.find((reason) => reason._tag === "Fail")
  return failed?._tag === "Fail" && failed.error instanceof Error
    ? failed.error.message
    : "The request could not be confirmed. Try again when the connection is available."
}

function OwnedSummaryRecovery({
  agentId,
  view,
  refresh,
}: {
  agentId: string
  view: SummaryRecoveryView
  refresh: () => void
}) {
  const api = useMemo(() => agentApi(agentId), [agentId])
  const [actor, setActor] = useState<EffectActor<Machine> | null>(null)
  const [snapshot, setSnapshot] = useState<SnapshotFrom<Machine> | null>(null)
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const owned = yield* makeSummaryRecovery(view, (request) =>
          requestSummaryRecovery(api, sessionStorage, agentId, request).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (mounted) refresh()
              })
            )
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
    // Authoritative updates enter the existing actor; they do not restart work.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [api, agentId, refresh])
  useEffect(() => {
    if (actor) Effect.runFork(send(actor, { type: "VIEW", ...view }))
  }, [actor, view])
  const pending = snapshot?.matches("requesting") === true
  const request = snapshot?.context.request
  const outcome = snapshot?.context.outcome
  const current = request && currentRecoveryRequest(view, request)
  const error = recoveryError(view, snapshot)
  const disabled = (input: SummaryRecoveryRequest) =>
    !actor ||
    pending ||
    snapshot?.context.acknowledged.some(
      (accepted) => recoveryRequestKey(accepted) === recoveryRequestKey(input)
    ) === true
  const retry = (request: SummaryRecoveryRequest) => {
    if (actor) Effect.runFork(send(actor, { type: "SUBMIT", request }))
  }
  const paused = view.issues.filter((issue) => issue.retryAt === null)
  return (
    <div className="space-y-3" aria-label="Memory recovery">
      {view.recovery && (
        <Alert>
          <AlertTitle>Memory compaction needs attention</AlertTitle>
          <AlertDescription className="flex min-w-0 flex-col gap-2">
            <p>{view.recovery.message}</p>
            <p>
              Retrying the scheduler checks pending work. Paused summaries still
              need a separate explicit retry.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled({
                kind: "scheduler",
                epoch: view.recovery.epoch,
              })}
              onClick={() =>
                retry({ kind: "scheduler", epoch: view.recovery!.epoch })
              }
            >
              {pending && request?.kind === "scheduler"
                ? "Retrying scheduler…"
                : "Retry compaction scheduler"}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {paused.length > 0 && (
        <Alert>
          <AlertTitle>Memory summaries paused</AlertTitle>
          <AlertDescription className="flex min-w-0 flex-col gap-2">
            <p>
              These summaries are paused. Original messages and completed
              summaries remain saved. Check the ChatGPT connection and the
              Memory summaries job default. Retrying a summary explicitly starts
              a new attempt with that setting.
            </p>
            {paused.map((issue) => {
              const input = {
                kind: "summary" as const,
                start: issue.start,
                count: issue.count,
                attempts: issue.attempts,
              }
              return (
                <Button
                  key={`${issue.start}+${issue.count}`}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-auto w-full min-w-0 py-2 whitespace-normal"
                  disabled={disabled(input)}
                  onClick={() => retry(input)}
                >
                  {pending &&
                  request &&
                  recoveryRequestKey(request) === recoveryRequestKey(input)
                    ? "Retrying…"
                    : `Retry summary ${issue.start}+${issue.count}`}
                </Button>
              )
            })}
          </AlertDescription>
        </Alert>
      )}
      {error && <p role="alert">{error}</p>}
      {current && outcome && Exit.isSuccess(outcome) && (
        <p role="status">
          Request accepted. Waiting for updated memory status.
        </p>
      )}
    </div>
  )
}

export function SummaryRecovery({
  agentId,
  issues,
  recovery,
  refresh,
}: {
  agentId: string
  refresh: () => void
  issues: readonly SummaryIssue[]
  recovery?: CompactionRecovery
}) {
  return (
    <OwnedSummaryRecovery
      key={agentId}
      agentId={agentId}
      refresh={refresh}
      view={{ issues, recovery: recovery ?? null }}
    />
  )
}
