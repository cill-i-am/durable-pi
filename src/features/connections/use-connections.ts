import { Schema } from "effect"
import { useCallback, useRef, useState } from "react"

import {
  ConnectionList,
  ToolSelection,
  type ConnectionInfo,
  type NewConnection,
} from "@/access/connections"
import { agentApi } from "@/http/client"

export function useConnections(agentId: string, onSaved: () => void) {
  const [connections, setConnections] = useState<readonly ConnectionInfo[]>([])
  const [selection, setSelection] = useState<ToolSelection>({
    revision: 0,
    tools: [],
  })
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const sequence = useRef(0),
    locked = useRef(false)
  const refresh = useCallback(async () => {
    if (locked.current) return
    const revision = ++sequence.current
    setLoading(true)
    try {
      const [library, selected] = await Promise.all([
        agentApi("home")("connections").then(
          Schema.decodeUnknownSync(ConnectionList)
        ),
        agentApi(agentId)("remote-tools").then(
          Schema.decodeUnknownSync(ToolSelection)
        ),
      ])
      if (revision !== sequence.current) return
      setConnections(library.connections)
      setSelection(selected)
      setReady(true)
      setError("")
    } catch (cause) {
      if (revision === sequence.current)
        setError(
          cause instanceof Error ? cause.message : "Could not load connections."
        )
    } finally {
      if (revision === sequence.current) setLoading(false)
    }
  }, [agentId])
  async function mutate<T>(work: () => Promise<T>, apply: (value: T) => void) {
    if (locked.current) return false
    locked.current = true
    sequence.current++
    setLoading(false)
    setBusy(true)
    setError("")
    try {
      apply(await work())
      onSaved()
      return true
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not update connections. Reload to check the result."
      )
      return false
    } finally {
      locked.current = false
      setBusy(false)
    }
  }
  const change = (path: string, body: unknown) =>
    mutate(
      () =>
        agentApi("home")(`connections/${path}`, body).then(
          Schema.decodeUnknownSync(ConnectionList)
        ),
      (value) => setConnections(value.connections)
    )
  return {
    connections,
    selection,
    error,
    loading,
    busy,
    ready,
    refresh,
    add: (input: NewConnection) => change("add", input),
    change: (
      connection: ConnectionInfo,
      action: "refresh" | "reconnect" | "disconnect"
    ) =>
      change(action, {
        id: connection.id,
        expectedRevision: connection.revision,
      }),
    select: (names: readonly string[]) =>
      mutate(
        () =>
          agentApi(agentId)("remote-tools", {
            expectedRevision: selection.revision,
            names,
          }).then(Schema.decodeUnknownSync(ToolSelection)),
        setSelection
      ),
  }
}
