import { Schema } from "effect"
import { useCallback, useEffect, useRef, useState } from "react"

import { agentApi } from "@/http/client"
import { poll } from "@/http/poll"
import {
  CommandRun,
  CommandInput,
  TerminalState,
  type TerminalNetworkPolicy,
  type CommandSummary,
  type InteractiveState,
} from "@/terminal/contracts"

import { maintainSessionLease, type LeaseState } from "./session-lease"

export function useTerminal(
  agentId: string,
  selected: string | null,
  setSelected: (id: string | null) => void
) {
  const [networkPolicy, setNetworkPolicy] = useState<
    TerminalNetworkPolicy | null | undefined
  >(undefined)
  const [session, setSession] = useState<typeof InteractiveState.Type | null>(
    null
  )
  const [lease, setLease] = useState<LeaseState>({ ended: false, error: "" })
  const expiry = useRef(0)
  expiry.current = session?.expiresAt ?? 0
  useEffect(() => {
    setLease({ ended: false, error: "" })
    if (!session || session.phase !== "ready") return
    return maintainSessionLease(
      expiry.current,
      (signal) =>
        agentApi(agentId)(
          `terminal/session/${encodeURIComponent(session.id)}/renew`,
          {},
          signal
        ),
      setLease
    )
  }, [agentId, session?.id, session?.phase])
  const [transferAttempt, setTransferAttempt] = useState<
    | { kind: "import"; input: { id: string; fileId: string } }
    | { kind: "export"; input: { id: string; path: string } }
    | null
  >(null)
  const [sessionAttempt, setSessionAttempt] = useState<string | null>(null)
  const [runs, setRuns] = useState<CommandSummary[]>([])
  const [cleanupError, setCleanupError] = useState<string | null>(null)
  const [runtimeBusy, setRuntimeBusy] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [detail, setDetail] = useState<CommandRun | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState<CommandInput | null>(null)
  const sequence = useRef(0),
    lock = useRef(false)
  const refresh = useCallback(async () => {
    if (lock.current) return
    const generation = ++sequence.current
    try {
      const history = Schema.decodeUnknownSync(TerminalState)(
        await agentApi(agentId)("terminal")
      )
      const run = selected
        ? Schema.decodeUnknownSync(CommandRun)(
            await agentApi(agentId)(`terminal/${encodeURIComponent(selected)}`)
          )
        : null
      if (generation === sequence.current) {
        setRuns([...history.runs])
        setRuntimeBusy(history.busy)
        setCleanupError(history.cleanupError)
        setSavedAt(history.savedAt)
        setSession(history.session)
        setNetworkPolicy(history.networkPolicy ?? null)
        setDetail(run)
      }
    } catch (cause) {
      if (generation === sequence.current)
        setError(
          cause instanceof Error ? cause.message : "Could not load runs."
        )
    }
  }, [agentId, selected])
  useEffect(() => {
    setDetail(null)
    setError("")
    const stop = poll(
      async () => {
        if (document.visibilityState === "visible") await refresh()
      },
      2500,
      true
    )
    return () => {
      stop()
      sequence.current++
    }
  }, [refresh])
  async function command(path: string, input: unknown) {
    if (lock.current) return null
    lock.current = true
    sequence.current++
    setBusy(true)
    setError("")
    try {
      const run = Schema.decodeUnknownSync(CommandRun)(
        await agentApi(agentId)(path, input)
      )
      setRuntimeBusy(true)
      setSelected(run.id)
      setDetail(run)
      setRuns((values) =>
        [
          { ...run, label: run.command.slice(0, 100) },
          ...values.filter((value) => value.id !== run.id),
        ].slice(0, 20)
      )
      return run
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The request failed. Retry the same run."
      )
      return null
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  async function start(commandText: string) {
    const input = attempt ?? { id: crypto.randomUUID(), command: commandText }
    try {
      Schema.decodeUnknownSync(CommandInput)(input)
    } catch {
      setError("Enter a command up to 16,000 characters.")
      return
    }
    setAttempt(input)
    if (await command("terminal/run", input)) setAttempt(null)
  }
  async function transfer(next: NonNullable<typeof transferAttempt>) {
    const pending = transferAttempt ?? next
    setTransferAttempt(pending)
    const result = await command(
      pending.kind === "import" ? "terminal/files/import" : "terminal/export",
      pending.input
    )
    if (result) setTransferAttempt(null)
  }
  async function openSession() {
    const id = sessionAttempt ?? crypto.randomUUID()
    setSessionAttempt(id)
    if (await command("terminal/session", { id })) {
      setSessionAttempt(null)
      await refresh()
    }
  }
  async function cancelTransfer() {
    if (!transferAttempt || lock.current) return
    lock.current = true
    sequence.current++
    setBusy(true)
    try {
      await agentApi(agentId)(
        `terminal/${encodeURIComponent(transferAttempt.input.id)}/cancel`,
        {}
      )
      setTransferAttempt(null)
      setError("")
    } catch {
      setError(
        "Cancellation is unconfirmed. Retry cancellation or the same transfer."
      )
    } finally {
      lock.current = false
      setBusy(false)
      await refresh()
    }
  }
  async function saveSession() {
    if (!session || lock.current) return
    lock.current = true
    sequence.current++
    setBusy(true)
    setError("")
    try {
      await agentApi(agentId)(
        `terminal/session/${encodeURIComponent(session.id)}/save`,
        {}
      )
    } catch {
      setError(
        "Save could not be confirmed. Check the saved command status before starting again."
      )
    } finally {
      lock.current = false
      setBusy(false)
      await refresh()
    }
  }
  return {
    cancelPending: async () => {
      const id = attempt?.id ?? sessionAttempt ?? transferAttempt?.input.id
      if (!id || lock.current) return
      lock.current = true
      sequence.current++
      setBusy(true)
      try {
        await agentApi(agentId)(`terminal/${encodeURIComponent(id)}/cancel`, {})
        setAttempt((current) => (current?.id === id ? null : current))
        setSessionAttempt((current) => (current === id ? null : current))
        setTransferAttempt((current) =>
          current?.input.id === id ? null : current
        )
        setError("")
      } catch {
        setError("Cancellation is unconfirmed. Retry cancelling this request.")
      } finally {
        lock.current = false
        setBusy(false)
        await refresh()
      }
    },
    networkPolicy,
    configureNetwork: async (input: TerminalNetworkPolicy) => {
      if (lock.current) return false
      lock.current = true
      sequence.current++
      setBusy(true)
      setError("")
      try {
        const state = Schema.decodeUnknownSync(TerminalState)(
          await agentApi(agentId)("terminal/network", input)
        )
        setNetworkPolicy(state.networkPolicy ?? null)
        return true
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not save internet settings. Reload and try again."
        )
        return false
      } finally {
        lock.current = false
        setBusy(false)
        await refresh()
      }
    },
    runs,
    transferAttempt,
    importFile: (fileId: string) =>
      transfer({ kind: "import", input: { id: crypto.randomUUID(), fileId } }),
    exportFile: (path: string) =>
      transfer({ kind: "export", input: { id: crypto.randomUUID(), path } }),
    retryTransfer: () =>
      transferAttempt ? transfer(transferAttempt) : Promise.resolve(),
    cancelTransfer,
    session,
    lease,
    sessionAttempt,
    openSession,
    saveSession,
    runtimeBusy,
    cleanupError,
    cleanup: async () => {
      try {
        await agentApi(agentId)("terminal/cleanup", {})
        await refresh()
      } catch {
        setError("Could not request cleanup. Try again.")
      }
    },
    savedAt,
    detail: detail?.id === selected ? detail : null,
    selected,
    busy,
    error,
    attempt,
    refresh: () => {
      setError("")
      return refresh()
    },
    start,
    cancel: (id: string) =>
      command(`terminal/${encodeURIComponent(id)}/cancel`, {}),
  }
}
