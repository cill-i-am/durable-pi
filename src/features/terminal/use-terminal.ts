import { useCallback, useEffect, useRef, useState } from "react"
import { Schema } from "effect"
import {
  CommandRun,
  CommandInput,
  TerminalState,
  type CommandSummary,
} from "@/terminal/contracts"
import { agentApi } from "@/http/client"
import { poll } from "@/http/poll"

export function useTerminal(agentId: string) {
  const [runs, setRuns] = useState<CommandSummary[]>([])
  const [cleanupError, setCleanupError] = useState<string | null>(null)
  const [runtimeBusy, setRuntimeBusy] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
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
  return {
    runs,
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
    detail,
    selected,
    busy,
    error,
    attempt,
    refresh: () => {
      setError("")
      return refresh()
    },
    select: (id: string | null) => {
      sequence.current++
      setSelected(id)
      setDetail(null)
      setError("")
    },
    start,
    cancel: (id: string) =>
      command(`terminal/${encodeURIComponent(id)}/cancel`, {}),
  }
}
