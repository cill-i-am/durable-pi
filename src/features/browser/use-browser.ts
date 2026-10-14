import { useCallback, useEffect, useRef, useState } from "react"
import { Schema } from "effect"
import { poll } from "@/http/poll"
import { agentApi } from "@/http/client"
import { BrowserState } from "@/browser/contracts"

export function useBrowser(agentId: string) {
  const [state, setState] = useState<BrowserState | null>(null)
  const [error, setError] = useState("")
  const [pending, setPending] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const sequence = useRef(0),
    locked = useRef(0)
  const refresh = useCallback(async () => {
    if (locked.current) return
    const current = ++sequence.current
    try {
      const value = Schema.decodeUnknownSync(BrowserState)(
        await agentApi(agentId)("browser")
      )
      if (current === sequence.current) {
        setState(value)
      }
    } catch (cause) {
      if (current === sequence.current)
        setError(
          cause instanceof Error ? cause.message : "Could not load the browser."
        )
    }
  }, [agentId])
  useEffect(() => {
    const stop = poll(
      async () => {
        if (document.visibilityState === "visible") await refresh()
      },
      5000,
      true
    )
    return () => {
      stop()
      sequence.current++
    }
  }, [refresh])
  async function command(path: string, body: unknown, interrupt = false) {
    if (locked.current && !interrupt) return false
    const current = ++sequence.current
    locked.current = current
    setBusy(true)
    setPending(path)
    setError("")
    try {
      const input =
        path === "close" && interrupt
          ? {
              generation: Schema.decodeUnknownSync(BrowserState)(
                await agentApi(agentId)("browser")
              ).policy.generation,
            }
          : body
      const value = Schema.decodeUnknownSync(BrowserState)(
        await agentApi(agentId)(`browser/${path}`, input)
      )
      if (current !== sequence.current) return false
      setState(value)
      return true
    } catch (cause) {
      if (current === sequence.current)
        setError(
          cause instanceof Error ? cause.message : "The browser request failed."
        )
      return false
    } finally {
      if (locked.current === current) {
        locked.current = 0
        setBusy(false)
        setPending(null)
        void refresh()
      }
    }
  }
  return {
    state,
    error,
    busy,
    pending,
    refresh: () => {
      setError("")
      return refresh()
    },
    command,
  }
}
