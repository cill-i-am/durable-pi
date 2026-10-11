import { useCallback, useEffect, useRef, useState } from "react"
import { Schema } from "effect"
import { AppDetail, AppDocument } from "@/apps/contracts"
import { agentApi } from "@/http/client"
import { poll } from "@/http/poll"

export function useApp(agentId: string, id: string) {
  const [detail, setDetail] = useState<AppDetail | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState<{
    path: string
    input: Record<string, unknown> & { operationId: string }
  } | null>(null)
  const lock = useRef(false),
    sequence = useRef(0)
  const refresh = useCallback(
    async (force = false) => {
      if (lock.current && !force) return
      const generation = ++sequence.current
      try {
        const value = Schema.decodeUnknownSync(AppDetail)(
          await agentApi(agentId)(`apps/${id}`)
        )
        if (generation === sequence.current) setDetail(value)
        return true
      } catch (cause) {
        if (generation === sequence.current)
          setError(
            cause instanceof Error ? cause.message : "Could not load the app."
          )
      }
    },
    [agentId, id]
  )
  useEffect(() => {
    const stop = poll(
      async () => {
        if (document.visibilityState === "visible") await refresh()
      },
      4000,
      true
    )
    return () => {
      stop()
      sequence.current++
    }
  }, [refresh])
  async function mutate(path: string, input: Record<string, unknown>) {
    if (lock.current) return false
    const pending = attempt ?? {
      path,
      input: { ...input, operationId: crypto.randomUUID() },
    }
    lock.current = true
    sequence.current++
    setBusy(true)
    setAttempt(pending)
    setError("")
    try {
      const document = Schema.decodeUnknownSync(AppDocument)(
        await agentApi(agentId)(pending.path, pending.input)
      )
      setDetail((current) =>
        current ? { ...current, app: document } : current
      )
      setAttempt(null)
      return true
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The change is unconfirmed. Retry the same request."
      )
      return false
    } finally {
      await refresh(true)
      lock.current = false
      setBusy(false)
    }
  }
  async function cancel() {
    if (!attempt || lock.current) return
    lock.current = true
    sequence.current++
    setBusy(true)
    try {
      const response = await agentApi(agentId)<{ applied: boolean }>(
        "apps/cancel",
        { operationId: attempt.input.operationId }
      )
      if (response.applied && !(await refresh(true)))
        throw new Error("Could not reload the applied change")
      setAttempt(null)
      setError(
        response.applied
          ? "The previous change was already saved. The latest app is shown."
          : ""
      )
    } catch {
      setError(
        "Cancellation is unconfirmed. Retry before making a different change."
      )
    } finally {
      await refresh(true)
      lock.current = false
      setBusy(false)
    }
  }
  return {
    detail,
    error,
    busy,
    attempt,
    refresh,
    mutate,
    cancel,
    retry: () =>
      attempt ? mutate(attempt.path, attempt.input) : Promise.resolve(false),
  }
}
