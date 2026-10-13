import { useCallback, useEffect, useRef, useState } from "react"
import { Schema } from "effect"
import {
  RoutineList,
  RoutineChange,
  type SaveRoutine,
  type SetRoutineStatus,
  type RunRoutineNow,
} from "@/routines/contracts"
import { agentApi } from "@/http/client"
import { poll } from "@/http/poll"

type Change =
  | { path: "save"; body: SaveRoutine }
  | { path: "status"; body: SetRoutineStatus }
  | { path: "run"; body: RunRoutineNow }
export function useRoutines(
  agentId: string,
  onApplied: () => void,
  onPendingChange: (pending: boolean) => void
) {
  const [data, setData] = useState<RoutineList>({ routines: [], runs: [] })
  const [loading, setLoading] = useState(true),
    [error, setError] = useState("")
  const [busy, setBusy] = useState(false),
    [attempt, setAttempt] = useState<Change | null>(null)
  const sequence = useRef(0),
    lock = useRef(false)
  const refresh = useCallback(
    async (force = false) => {
      if (lock.current && !force) return false
      const generation = ++sequence.current
      try {
        const value = Schema.decodeUnknownSync(RoutineList)(
          await agentApi(agentId)("routines")
        )
        if (generation === sequence.current) {
          setData(value)
          setLoading(false)
          return true
        }
      } catch (cause) {
        if (generation === sequence.current) {
          setError(
            cause instanceof Error ? cause.message : "Could not load routines."
          )
          setLoading(false)
        }
      }
      return false
    },
    [agentId]
  )
  useEffect(() => {
    const stopPolling = poll(
      async () => {
        if (document.visibilityState === "visible") await refresh()
      },
      4000,
      true
    )
    return () => {
      stopPolling()
      sequence.current++
    }
  }, [refresh])
  async function send(change: Change) {
    if (lock.current) return
    lock.current = true
    sequence.current++
    onPendingChange(true)
    setBusy(true)
    setAttempt(change)
    setError("")
    let confirmed = false
    try {
      const result = Schema.decodeUnknownSync(RoutineChange)(
        await agentApi(agentId)(`routines/${change.path}`, change.body)
      )
      sequence.current++
      setData((current) => ({
        routines: current.routines.some((r) => r.id === result.routine.id)
          ? current.routines.map((r) =>
              r.id === result.routine.id &&
              r.revision <= result.routine.revision
                ? result.routine
                : r
            )
          : [result.routine, ...current.routines],
        runs:
          result.run && !current.runs.some((r) => r.id === result.run!.id)
            ? [result.run, ...current.runs].slice(0, 200)
            : current.runs,
      }))
      confirmed = true
      setAttempt(null)
      onApplied()
      await refresh(true)
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The change was not confirmed. Retry or resolve it before another change."
      )
    } finally {
      lock.current = false
      setBusy(false)
      onPendingChange(!confirmed)
    }
  }
  async function resolve() {
    if (!attempt || lock.current) return
    lock.current = true
    sequence.current++
    onPendingChange(true)
    setBusy(true)
    setError("")
    let confirmed = false
    try {
      const result = await agentApi(agentId)<{ applied: boolean }>(
        "routines/cancel",
        { operationId: attempt.body.operationId }
      )
      if (!(await refresh(true)))
        throw new Error(
          "The request was resolved, but current routines could not load. Retry resolving before another change."
        )
      confirmed = true
      setAttempt(null)
      if (result.applied) onApplied()
      setError(
        result.applied
          ? "The previous change was already saved."
          : "The unconfirmed change was cancelled. You can edit or try again."
      )
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not resolve the change. Retry."
      )
    } finally {
      lock.current = false
      setBusy(false)
      onPendingChange(!confirmed)
    }
  }
  async function stop(id: string) {
    if (lock.current || attempt) return
    lock.current = true
    sequence.current++
    onPendingChange(true)
    setBusy(true)
    setError("")
    try {
      await agentApi(agentId)("routines/stop", { id })
      await refresh(true)
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Stop was not confirmed. Retry stopping the same run."
      )
    } finally {
      lock.current = false
      setBusy(false)
      onPendingChange(false)
    }
  }
  return {
    data,
    loading,
    error,
    busy,
    attempt,
    refresh,
    send,
    resolve,
    stop,
    retryLoad: () => {
      if (lock.current || attempt) return Promise.resolve(false)
      setError("")
      return refresh()
    },
  }
}
