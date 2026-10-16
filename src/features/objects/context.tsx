import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"

import { agentApi } from "@/http/client"
import { poll } from "@/http/poll"

import { ObjectStore } from "./store"

const Context = createContext<{
  store: ObjectStore
  open: (id: string) => void
  agentId: string
  archived: boolean
  observe: () => () => void
} | null>(null)
export function ObjectsProvider({
  agentId,
  archived,
  onOpen,
  onPendingChange,
  children,
}: {
  agentId: string
  archived: boolean
  onOpen: (id: string) => void
  onPendingChange: (busy: boolean) => void
  children: ReactNode
}) {
  const [consumers, setConsumers] = useState(0)
  const observe = useCallback(() => {
    setConsumers((count) => count + 1)
    return () => setConsumers((count) => count - 1)
  }, [])
  const [store] = useState(
    () => new ObjectStore(agentApi(agentId), `pi:object-changes:${agentId}`)
  )
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot
  )
  useEffect(() => {
    try {
      store.connect(sessionStorage)
    } catch {}
  }, [store])
  useEffect(() => {
    onPendingChange(Object.keys(state.pending).length > 0)
    return () => onPendingChange(false)
  }, [state.pending, onPendingChange])
  const refreshing = consumers > 0 || Object.keys(state.pending).length > 0
  useEffect(() => {
    if (!refreshing) return
    const refresh = async () => {
      if (document.visibilityState === "visible") {
        await store.refresh()
        await Promise.all(
          Object.keys(store.getSnapshot().details).map((id) => store.load(id))
        )
      }
    }
    const stop = poll(refresh, 4000, true)
    const reconnect = () => void refresh()
    window.addEventListener("online", reconnect)
    document.addEventListener("visibilitychange", reconnect)
    return () => {
      stop()
      window.removeEventListener("online", reconnect)
      document.removeEventListener("visibilitychange", reconnect)
    }
  }, [store, refreshing])
  return (
    <Context value={{ store, open: onOpen, agentId, archived, observe }}>
      {children}
    </Context>
  )
}
export function useObjects() {
  return useContext(Context)
}
export function useObjectState(store: ObjectStore) {
  const context = useObjects()
  const observe = context?.store === store ? context.observe : undefined
  useEffect(() => observe?.(), [observe])
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot
  )
}
