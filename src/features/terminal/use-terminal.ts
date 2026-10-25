import { send } from "@xstate/effect"
import { Cause, Effect, Exit, Fiber, Schema } from "effect"
import { useEffect, useRef, useState } from "react"
import type { SnapshotFrom } from "xstate"

import { agentApi } from "@/http/client"
import { CommandInput, type TerminalNetworkPolicy } from "@/terminal/contracts"

import { maintainSessionLease, type LeaseState } from "./session-lease"
import {
  makeTerminalOwner,
  terminalCommand,
  terminalRequests,
  type TerminalActor,
} from "./terminal-owner"
import type { terminalUiMachine, TerminalIntent } from "./terminal-ui.machine"

type Snapshot = SnapshotFrom<ReturnType<typeof terminalUiMachine>>
function useTerminalOwner(
  agentId: string,
  selected: string | null,
  setSelected: (id: string | null) => void
) {
  const latest = useRef({ selected, setSelected })
  useEffect(() => {
    latest.current = { selected, setSelected }
  })
  const [actor, setActor] = useState<TerminalActor | null>(null)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const owned = yield* makeTerminalOwner(
          {
            agentId,
            selected: latest.current.selected,
            visible: document.visibilityState === "visible",
          },
          terminalRequests(agentId)
        )
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            owned.subscribe((value) => {
              if (mounted) setSnapshot(value)
            })
          ),
          (subscription) => Effect.sync(() => subscription.unsubscribe())
        )
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            owned.on("selected", ({ id }) => {
              if (mounted) latest.current.setSelected(id)
            })
          ),
          (subscription) => Effect.sync(() => subscription.unsubscribe())
        )
        const visibility = () =>
          Effect.runFork(
            send(owned, {
              type: "VISIBILITY",
              visible: document.visibilityState === "visible",
            })
          )
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            document.addEventListener("visibilitychange", visibility)
          ),
          () =>
            Effect.sync(() =>
              document.removeEventListener("visibilitychange", visibility)
            )
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
  }, [agentId])
  const owner = actor?.getSnapshot().context.agentId === agentId ? actor : null
  useEffect(() => {
    if (owner) Effect.runFork(send(owner, { type: "SELECT", selected }))
  }, [owner, selected])
  const current =
    snapshot?.context.agentId === agentId ? snapshot.context : null
  return { owner, current }
}

function useTerminalLease(
  agentId: string,
  session: NonNullable<Snapshot["context"]["history"]>["session"]
) {
  const [leaseState, setLease] = useState<{
    agentId: string
    sessionId: string
    state: LeaseState
  } | null>(null)
  const expiry = useRef(0)
  expiry.current = session?.expiresAt ?? 0
  const sessionId = session?.id,
    sessionPhase = session?.phase
  useEffect(() => {
    if (!sessionId || sessionPhase !== "ready") return
    return maintainSessionLease(
      expiry.current,
      (signal) =>
        agentApi(agentId)(
          `terminal/session/${encodeURIComponent(sessionId)}/renew`,
          {},
          signal
        ),
      (state) => setLease({ agentId, sessionId, state })
    )
  }, [agentId, sessionId, sessionPhase])
  return leaseState?.agentId === agentId && leaseState.sessionId === sessionId
    ? leaseState.state
    : { ended: false, error: "" }
}

function historyProjection(
  current: Snapshot["context"] | null,
  selected: string | null
) {
  const history = current?.history
  return {
    networkPolicy: history ? (history.networkPolicy ?? null) : undefined,
    runs: history?.runs ?? [],
    session: history?.session ?? null,
    runtimeBusy: history?.busy ?? false,
    cleanupError: history?.cleanupError ?? null,
    savedAt: history?.savedAt ?? null,
    detail: current?.detail?.id === selected ? current.detail : null,
    selected,
    busy: !current || !!current.request,
    error: current?.error ?? "",
  }
}
function attemptProjection(
  pending: Snapshot["context"]["pending"] | undefined
) {
  return {
    transferAttempt:
      pending?.kind === "import" || pending?.kind === "export" ? pending : null,
    sessionAttempt: pending?.kind === "session" ? pending.input.id : null,
    attempt: pending?.kind === "command" ? pending.input : null,
  }
}

export function useTerminal(
  agentId: string,
  selected: string | null,
  setSelected: (id: string | null) => void
) {
  const { owner, current } = useTerminalOwner(agentId, selected, setSelected)
  const view = historyProjection(current, selected)
  const lease = useTerminalLease(agentId, view.session)
  const command = (intent: TerminalIntent) =>
    owner
      ? Effect.runPromise(terminalCommand(owner, intent))
      : Promise.resolve(false)
  return {
    ...view,
    ...attemptProjection(current?.pending),
    lease,
    configureNetwork: (policy: TerminalNetworkPolicy) =>
      command({ type: "network", policy }),
    importFile: (fileId: string) =>
      command({
        type: "start",
        attempt: { kind: "import", input: { id: crypto.randomUUID(), fileId } },
      }),
    exportFile: (path: string) =>
      command({
        type: "start",
        attempt: { kind: "export", input: { id: crypto.randomUUID(), path } },
      }),
    retryTransfer: () => command({ type: "retry" }),
    cancelTransfer: () => command({ type: "cancelPending" }),
    cancelPending: () => command({ type: "cancelPending" }),
    openSession: () =>
      command({
        type: "start",
        attempt: { kind: "session", input: { id: crypto.randomUUID() } },
      }),
    saveSession: () => command({ type: "save" }),
    cleanup: () => command({ type: "cleanup" }),
    refresh: () =>
      owner
        ? Effect.runPromise(send(owner, { type: "REFRESH" }))
        : Promise.resolve(),
    start: (text: string) => {
      const input = { id: crypto.randomUUID(), command: text }
      if (!Schema.is(CommandInput)(input)) {
        if (owner)
          Effect.runFork(
            send(owner, {
              type: "INVALID",
              message: "Enter a command up to 16,000 characters.",
            })
          )
        return Promise.resolve(false)
      }
      return command({ type: "start", attempt: { kind: "command", input } })
    },
    cancel: (id: string) => command({ type: "cancel", id }),
  }
}
