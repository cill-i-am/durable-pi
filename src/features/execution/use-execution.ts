import { Schema } from "effect"
import { useCallback, useEffect, useRef, useState } from "react"

import {
  CodeRun,
  CodeInput,
  RunHistory,
  type RunInput,
  type RunSummary,
} from "@/execution/contracts"
import { agentApi } from "@/http/client"
import { poll } from "@/http/poll"

export function useExecution(
  agentId: string,
  selected: string | null,
  setSelected: (id: string | null) => void
) {
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [detail, setDetail] = useState<CodeRun | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState<RunInput | null>(null)
  const sequence = useRef(0),
    lock = useRef(false)
  const refresh = useCallback(async () => {
    if (lock.current) return
    const generation = ++sequence.current
    try {
      const history = Schema.decodeUnknownSync(RunHistory)(
        await agentApi(agentId)("execution")
      )
      const run = selected
        ? Schema.decodeUnknownSync(CodeRun)(
            await agentApi(agentId)(`execution/${encodeURIComponent(selected)}`)
          )
        : null
      if (generation === sequence.current) {
        setRuns([...history.runs])
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
      const run = Schema.decodeUnknownSync(CodeRun)(
        await agentApi(agentId)(path, input)
      )
      setSelected(run.id)
      setDetail(run)
      setRuns((values) =>
        [run, ...values.filter((value) => value.id !== run.id)].slice(0, 50)
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
  async function start(code: string, data: string) {
    if (!attempt) {
      try {
        Schema.decodeUnknownSync(CodeInput)({ code, data })
      } catch {
        setError(
          "Use valid JSON input and code within the displayed size limits."
        )
        return
      }
    }
    const input = attempt ?? { id: crypto.randomUUID(), code, data }
    setAttempt(input)
    if (await command("execution/run", input)) setAttempt(null)
  }
  return {
    runs,
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
    cancel: async (id: string) => {
      const result = await command(
        `execution/${encodeURIComponent(id)}/cancel`,
        {}
      )
      if (result) setAttempt((current) => (current?.id === id ? null : current))
      return result
    },
  }
}
