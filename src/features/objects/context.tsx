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

import { ObjectStore } from "./store"

const Context = createContext<{
  store: ObjectStore
  open: (id: string) => void
  agentId: string
  archived: boolean
  observe: () => () => void
} | null>(null)
type Props = {
  agentId: string
  archived: boolean
  onOpen: (id: string) => void
  onPendingChange: (busy: boolean) => void
  children: ReactNode
}
export function ObjectsProvider(props: Props) {
  const [owned, setOwned] = useState<{
    agentId: string
    store: ObjectStore
  } | null>(null)
  useEffect(() => {
    const store = new ObjectStore(
      agentApi(props.agentId),
      `pi:object-changes:${props.agentId}`
    )
    try {
      store.connect(sessionStorage)
    } catch {}
    setOwned({ agentId: props.agentId, store })
    return () => {
      void store
        .dispose()
        .catch((cause) =>
          console.error("Checklist resource cleanup failed", cause)
        )
    }
  }, [props.agentId])
  return owned?.agentId === props.agentId ? (
    <ObjectScope key={props.agentId} {...props} store={owned.store} />
  ) : (
    props.children
  )
}
function ObjectScope({
  agentId,
  archived,
  onOpen,
  onPendingChange,
  children,
  store,
}: Props & { store: ObjectStore }) {
  const [consumers, setConsumers] = useState(0)
  const observe = useCallback(() => {
    setConsumers((count) => count + 1)
    return () => setConsumers((count) => count - 1)
  }, [])
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot
  )
  const pending = Object.keys(state.pending).length > 0
  useEffect(() => {
    onPendingChange(pending)
    return () => onPendingChange(false)
  }, [pending, onPendingChange])
  const active = consumers > 0 || pending
  useEffect(() => {
    const visibility = () =>
      void store.observe(active, document.visibilityState === "visible")
    const online = () => void store.reconnect()
    visibility()
    document.addEventListener("visibilitychange", visibility)
    window.addEventListener("online", online)
    return () => {
      document.removeEventListener("visibilitychange", visibility)
      window.removeEventListener("online", online)
    }
  }, [active, store])
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
  const context = useObjects(),
    observe = context?.store === store ? context.observe : undefined
  useEffect(() => observe?.(), [observe])
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot
  )
}
