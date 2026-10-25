import { send, type EffectActor } from "@xstate/effect"
import { Effect, Exit, Fiber } from "effect"
import { useEffect, useMemo, useState } from "react"
import type { SnapshotFrom } from "xstate"

import { Button } from "@/components/ui/button"
import type { ChatState } from "@/conversations/contracts"
import { agentApi } from "@/http/client"
import { nativeOperation } from "@/shared/interop"

import { makeRecoveryControls } from "./recovery-controls-owner"
import {
  recoveryControlsMachine,
  type RecoveryControlView,
  type RecoveryRequest,
} from "./recovery-controls.machine"

type RecoveryMachine = ReturnType<typeof recoveryControlsMachine>
type RecoverySnapshot = SnapshotFrom<RecoveryMachine>
const controlCopy = {
  handoff: "Reply delivery could not be confirmed. Your message is saved.",
  observe:
    "Reply status could not be confirmed. Your saved reply is still available.",
  stop: "Stop could not be confirmed. Check the reply or try Stop again.",
}

export function RecoveryControlsView({
  view,
  pending,
  awaitingSnapshot,
  failed,
  submit,
}: {
  view: RecoveryControlView
  pending: RecoveryRequest["action"] | null
  awaitingSnapshot: boolean
  failed: boolean
  submit: (action: RecoveryRequest["action"]) => void
}) {
  if (!view.unconfirmed) return null
  const disabled = view.busy || pending !== null || awaitingSnapshot
  return (
    <div className="my-3 space-y-2 text-sm" aria-label="Reply recovery">
      <p role="status">{controlCopy[view.unconfirmed]}</p>
      {view.busy && (
        <p className="text-muted-foreground">
          Waiting for the current request to finish cleanup.
        </p>
      )}
      {failed && (
        <p role="alert">
          The request could not be confirmed. Check the current status of the
          saved reply before trying again.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => submit("check")}
        >
          {pending === "check" ? "Checking reply…" : "Check reply"}
        </Button>
        {view.unconfirmed === "stop" && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => submit("stop")}
          >
            {pending === "stop" ? "Trying Stop…" : "Try Stop again"}
          </Button>
        )}
      </div>
    </div>
  )
}

export function requestRecovery(
  post: (
    path: string,
    body: { operationId: string; revision: number },
    signal: AbortSignal
  ) => Promise<unknown>,
  refresh: () => void,
  { action, operationId, revision }: RecoveryRequest
) {
  return nativeOperation(
    (signal) => post(`recovery/${action}`, { operationId, revision }, signal),
    (cause) => cause
  ).pipe(Effect.asVoid, Effect.ensuring(Effect.sync(refresh)))
}

function OwnedRecoveryControls({
  view,
  agentId,
  refresh,
}: {
  view: RecoveryControlView
  agentId: string
  refresh: () => void
}) {
  const api = useMemo(() => agentApi(agentId), [agentId])
  const [actor, setActor] = useState<EffectActor<RecoveryMachine> | null>(null)
  const [snapshot, setSnapshot] = useState<RecoverySnapshot | null>(null)
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const actor = yield* makeRecoveryControls(view, (request) =>
          requestRecovery(
            api,
            () => {
              if (mounted) refresh()
            },
            request
          )
        )
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            actor.subscribe((value) => {
              if (mounted) setSnapshot(value)
            })
          ),
          (subscription) => Effect.sync(() => subscription.unsubscribe())
        )
        if (mounted) {
          setActor(actor)
          setSnapshot(actor.getSnapshot())
        }
        return yield* Effect.never
      }).pipe(Effect.scoped)
    )
    return () => {
      mounted = false
      // Interruption signals the HTTP request and joins its settlement in the
      // component-owned scope; it never claims remote Stop acknowledgement.
      Effect.runFork(Fiber.interrupt(fiber))
    }
    // Subsequent authoritative views are events, not new request lifetimes.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [api, refresh])
  useEffect(() => {
    if (actor) Effect.runFork(send(actor, { type: "VIEW", ...view }))
  }, [actor, view])
  const pending = snapshot?.matches("requesting")
    ? (snapshot.context.request?.action ?? null)
    : null
  const outcome = snapshot?.context.outcome
  return (
    <RecoveryControlsView
      view={view}
      pending={pending}
      awaitingSnapshot={
        !actor ||
        (snapshot?.matches("settled") === true &&
          !!outcome &&
          Exit.isSuccess(outcome))
      }
      failed={!!outcome && Exit.isFailure(outcome)}
      submit={(action) => {
        if (actor)
          Effect.runFork(
            send(actor, {
              type: "SUBMIT",
              action,
              operationId: view.operationId,
              revision: view.revision,
            })
          )
      }}
    />
  )
}

export function RecoveryControls({
  turn,
  agentId,
  refresh,
}: {
  turn: ChatState["turns"][number]
  agentId: string
  refresh: () => void
}) {
  if (!turn.controlUnconfirmed || turn.revision === undefined) return null
  return (
    <OwnedRecoveryControls
      key={`${agentId}:${turn.id}`}
      agentId={agentId}
      refresh={refresh}
      view={{
        operationId: turn.id,
        revision: turn.revision,
        unconfirmed: turn.controlUnconfirmed,
        busy: turn.controlBusy ?? false,
      }}
    />
  )
}
