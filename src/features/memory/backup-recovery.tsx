import { Button } from "@workspace/ui/components/button"
import { send, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Exit, Fiber } from "effect"
import { useEffect, useMemo, useState } from "react"
import type { SnapshotFrom } from "xstate"

import type {
  BackupRecovery as Recovery,
  CompactionRecovery,
} from "@/conversations/contracts"
import { agentApi } from "@/http/client"
import { nativeOperation } from "@/shared/interop"

import { makeBackupRecovery } from "./backup-recovery-owner"
import {
  currentBackupRecovery,
  type BackupRecoveryRequest,
  type backupRecoveryMachine,
} from "./backup-recovery.machine"

type Machine = ReturnType<typeof backupRecoveryMachine>

export function requestBackupRecovery(
  post: (
    path: string,
    body: BackupRecoveryRequest,
    signal: AbortSignal
  ) => Promise<unknown>,
  refresh: () => void,
  recovery: BackupRecoveryRequest
) {
  return nativeOperation(
    (signal) =>
      post(
        "epoch" in recovery ? "memory/backup/recover" : "memory/backup/retry",
        recovery,
        signal
      ),
    (cause) => cause
  ).pipe(Effect.asVoid, Effect.ensuring(Effect.sync(refresh)))
}

function OwnedBackupRecovery({
  agentId,
  recovery,
  schedulerRecovery,
  refresh,
}: {
  agentId: string
  recovery: Recovery | null
  schedulerRecovery: CompactionRecovery | null
  refresh: () => void
}) {
  const api = useMemo(() => agentApi(agentId), [agentId])
  const [actor, setActor] = useState<EffectActor<Machine> | null>(null)
  const [snapshot, setSnapshot] = useState<SnapshotFrom<Machine> | null>(null)
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const owned = yield* makeBackupRecovery(
          { recovery, schedulerRecovery },
          (request) =>
            requestBackupRecovery(
              api,
              () => {
                if (mounted) refresh()
              },
              request
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
    // Changes in the failed owner update authority without restarting requests.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [api, refresh])
  useEffect(() => {
    if (actor)
      Effect.runFork(send(actor, { type: "VIEW", recovery, schedulerRecovery }))
  }, [actor, recovery, schedulerRecovery])
  if (!recovery && !schedulerRecovery) return null
  const current = currentBackupRecovery(
    { recovery, schedulerRecovery },
    snapshot?.context.request ?? null
  )
  const outcome = current ? snapshot?.context.outcome : undefined
  const pending = snapshot?.matches("requesting") === true
  const accepted = !!outcome && Exit.isSuccess(outcome)
  const failed = !!outcome && Exit.isFailure(outcome)
  return (
    <div className="mt-3 space-y-2" aria-label="Backup recovery">
      {schedulerRecovery && <p>{schedulerRecovery.message}</p>}
      <p className="text-sm text-muted-foreground">
        {schedulerRecovery
          ? "Retry recovery to check pending backup work. Saved memory and any completed backup remain available."
          : "Retry the failed backup. Saved memory and any completed backup remain available."}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!actor || pending || accepted}
        onClick={() => {
          if (actor)
            Effect.runFork(
              send(actor, {
                type: "SUBMIT",
                ...(schedulerRecovery
                  ? { epoch: schedulerRecovery.epoch }
                  : recovery!),
              })
            )
        }}
      >
        {schedulerRecovery
          ? pending
            ? "Retrying backup recovery…"
            : "Retry backup recovery"
          : pending
            ? "Retrying backup…"
            : "Retry backup"}
      </Button>
      {failed && (
        <p role="alert">
          The backup retry could not be confirmed. Check its current status or
          try again.
        </p>
      )}
      {accepted && (
        <p role="status">Retry requested. Waiting for updated backup status.</p>
      )}
    </div>
  )
}

export function BackupRecovery({
  agentId,
  recovery,
  schedulerRecovery,
  refresh,
}: {
  agentId: string
  recovery: Recovery | null
  schedulerRecovery: CompactionRecovery | null
  refresh: () => void
}) {
  return (
    <OwnedBackupRecovery
      key={agentId}
      agentId={agentId}
      recovery={recovery}
      schedulerRecovery={schedulerRecovery}
      refresh={refresh}
    />
  )
}
