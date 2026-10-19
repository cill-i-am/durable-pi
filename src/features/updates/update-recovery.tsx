import {
  Component,
  createContext,
  useContext,
  useEffect,
  useId,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"

import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Toaster, createToastManager } from "@/components/ui/toast"
import { buildRevision } from "@/deployment/revision"
import { reportClientError } from "@/observability/browser"

import { createRecovery, importFailure } from "./recovery"

type Recovery = ReturnType<typeof createRecovery>
const Context = createContext<{ recovery: Recovery; check: () => void } | null>(
  null
)
const empty = { revision: null, blocked: null, online: true, reloading: false }
const subscribeEmpty = () => () => {}
const snapshotEmpty = () => empty
function useRecovery() {
  const context = useContext(Context)
  const state = useSyncExternalStore(
    context?.recovery.subscribe ?? subscribeEmpty,
    context?.recovery.snapshot ?? snapshotEmpty,
    snapshotEmpty
  )
  return { ...context, state }
}

export function UpdateRecovery({ children }: { children: ReactNode }) {
  const [recovery] = useState(() =>
    createRecovery(buildRevision, () => window.location.reload())
  )
  const [manager] = useState(createToastManager)
  const [check] = useState(() => {
    let pending: Promise<void> | undefined
    return () => {
      if (pending || !navigator.onLine) return
      pending = fetch("/api/version", {
        cache: "no-store",
        credentials: "omit",
        signal: AbortSignal.timeout(5000),
      })
        .then(async (response) => {
          if (!response.ok) return
          const value: unknown = await response.json()
          if (value && typeof value === "object" && "revision" in value)
            recovery.observe(value.revision)
        })
        .catch(() => {
          /* Offline/service failures are not proof of an update. */
        })
        .finally(() => {
          pending = undefined
        })
    }
  })
  const state = useSyncExternalStore(
    recovery.subscribe,
    recovery.snapshot,
    snapshotEmpty
  )
  useEffect(() => {
    const inspect = () => {
      recovery.connection(navigator.onLine)
      if (document.visibilityState === "visible") check()
    }
    const preload = () => {
      inspect()
    }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (recovery.snapshot().blocked) event.preventDefault()
    }
    inspect()
    window.addEventListener("beforeunload", beforeUnload)
    window.addEventListener("focus", inspect)
    window.addEventListener("online", inspect)
    window.addEventListener("offline", inspect)
    document.addEventListener("visibilitychange", inspect)
    window.addEventListener("vite:preloadError", preload)
    const timer = setInterval(inspect, 300_000)
    return () => {
      clearInterval(timer)
      window.removeEventListener("beforeunload", beforeUnload)
      window.removeEventListener("focus", inspect)
      window.removeEventListener("online", inspect)
      window.removeEventListener("offline", inspect)
      document.removeEventListener("visibilitychange", inspect)
      window.removeEventListener("vite:preloadError", preload)
    }
  }, [check, recovery])
  useEffect(() => {
    if (!state.revision) return
    manager.add({
      id: "pi-update",
      title: "A new version of Pi is available",
      description:
        state.blocked ??
        (!state.online
          ? "Reconnect to the internet before reloading."
          : "Reload when you’re ready. Your saved work will reconnect."),
      timeout: 0,
      actionProps: {
        children: state.reloading ? "Reloading…" : "Reload",
        disabled: !!state.blocked || !state.online || state.reloading,
        onClick: () => {
          recovery.reload()
        },
      },
    })
  }, [state, manager, recovery])
  return (
    <Context value={{ recovery, check }}>
      <Toaster toastManager={manager}>{children}</Toaster>
    </Context>
  )
}

/** Register the existing feature's actual unsafe state. Drafts use this only
 * when their tab-local write failed; ongoing agent inference is not a fence. */
export function useReloadGuard(reason: string | null, active = true) {
  const context = useContext(Context)
  const id = useId()
  useEffect(() => {
    context?.recovery.block(id, active ? reason : null)
    return () => context?.recovery.block(id, null)
  }, [context?.recovery, id, reason, active])
}

export function ReloadRecovery() {
  const { recovery, check, state } = useRecovery()
  useEffect(() => {
    check?.()
  }, [check])
  return (
    <section className="p-4">
      <Alert className="max-w-lg">
        <AlertTitle>
          {state.revision ? "Pi has been updated" : "Couldn’t load this screen"}
        </AlertTitle>
        <AlertDescription className="flex flex-col gap-3">
          <p>
            {state.revision
              ? "Reload to open this screen with the new version."
              : "The screen’s files could not be downloaded. Reload to try again."}
          </p>
          {(state.blocked || !state.online) && (
            <p>
              {state.blocked ?? "Reconnect to the internet before reloading."}
            </p>
          )}
          <Button
            className="self-start"
            disabled={
              !recovery || !!state.blocked || !state.online || state.reloading
            }
            onClick={() => recovery?.reload()}
          >
            {state.reloading ? "Reloading…" : "Reload page"}
          </Button>
        </AlertDescription>
      </Alert>
    </section>
  )
}

/** Catch only asset-load failures locally, retaining the conversation and its
 * unsaved state. Ordinary render/loader failures keep their existing recovery. */
export class AssetBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error: unknown) {
    if (!importFailure(error)) throw error
    return { error }
  }
  componentDidCatch(error: Error) {
    void reportClientError(error)
  }
  render() {
    return this.state.error ? <ReloadRecovery /> : this.props.children
  }
}
