import {
  createContext,
  useCallback,
  useContext,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction,
} from "react"

/** Ordinary presentation values, never commands, receipts or lifecycle state.
 * The assistant workspace owns this cache and drops it on identity teardown. */
export function createResultViewStore() {
  const values = new Map<string, unknown>()
  const listeners = new Set<() => void>()
  return {
    read: <T,>(key: string, initial: () => T): T => {
      if (!values.has(key)) values.set(key, initial())
      return values.get(key) as T
    },
    write: <T,>(key: string, value: SetStateAction<T>, initial: () => T) => {
      const previous = values.has(key) ? (values.get(key) as T) : initial()
      const next =
        typeof value === "function"
          ? (value as (current: T) => T)(previous)
          : value
      if (Object.is(previous, next)) return
      values.set(key, next)
      for (const listener of listeners) listener()
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    clear: () => {
      values.clear()
      listeners.clear()
    },
  }
}
export const ResultViewStateContext = createContext<{
  store: ReturnType<typeof createResultViewStore>
  scope: string
} | null>(null)

export function useResultViewState<T>(
  name: string,
  initial: T | (() => T)
): [T, Dispatch<SetStateAction<T>>] {
  const context = useContext(ResultViewStateContext)
  const [fallback, setFallback] = useState(initial)
  const [initialize] = useState(() =>
    typeof initial === "function" ? (initial as () => T) : () => initial
  )
  const key = `${context?.scope ?? "inline"}:${name}`
  const read = useCallback(
    () => (context ? context.store.read(key, initialize) : fallback),
    [context, key, initialize, fallback]
  )
  const subscribe = useCallback(
    (listener: () => void) =>
      context ? context.store.subscribe(listener) : () => {},
    [context]
  )
  const value = useSyncExternalStore(subscribe, read, read)
  const set = useCallback<Dispatch<SetStateAction<T>>>(
    (next) => {
      if (context) context.store.write(key, next, initialize)
      else setFallback(next)
    },
    [context, key, initialize]
  )
  return [value, set]
}
