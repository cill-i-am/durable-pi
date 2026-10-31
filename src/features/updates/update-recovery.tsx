import {
  Alert,
  AlertTitle,
  AlertDescription,
} from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import { Effect, Fiber } from "effect"
import {
  Component,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"

import { Toaster, createToastManager } from "@/components/ui/toast"
import { buildRevision } from "@/deployment/revision"
import { reportClientError } from "@/observability/browser"

import {
  makeRecovery,
  watchRecovery,
  emptyRecovery,
  importFailure,
  type Recovery,
} from "./recovery"
import { requestRevision } from "./version-request"

const Context = createContext<{ recovery: Recovery; check: () => void } | null>(
  null
)
const subscribeEmpty = () => () => {}
const snapshotEmpty = () => emptyRecovery
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
  const [recovery, setRecovery] = useState<Recovery | null>(null)
  const [manager] = useState(createToastManager)
  useEffect(() => {
    let mounted = true
    let current: Recovery | undefined
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        current = yield* makeRecovery({
          currentRevision: buildRevision,
          reload: () => window.location.reload(),
          version: async (signal) => {
            if (document.visibilityState !== "visible" || !navigator.onLine)
              return null
            return requestRevision(signal)
          },
        })
        if (mounted) setRecovery(current)
        return yield* watchRecovery(current, window, document)
      }).pipe(Effect.scoped)
    )
    return () => {
      mounted = false
      current?.revoke()
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [])
  const check = useCallback(() => {
    if (recovery) Effect.runSync(recovery.check())
  }, [recovery])
  const state = useSyncExternalStore(
    recovery?.subscribe ?? subscribeEmpty,
    recovery?.snapshot ?? snapshotEmpty,
    snapshotEmpty
  )
  useEffect(() => {
    if (!state.revision || !recovery) return
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
          Effect.runFork(recovery.reload())
        },
      },
    })
  }, [state, manager, recovery])
  return (
    <Context value={recovery ? { recovery, check } : null}>
      <Toaster toastManager={manager}>{children}</Toaster>
    </Context>
  )
}

/** Register the existing feature's actual unsafe state. Drafts use this only
 * while tab-local storage is unsaved or unreadable. Inference is not a fence. */
export function useReloadGuard(reason: string | null, active = true) {
  const recovery = useContext(Context)?.recovery
  const id = useId()
  useEffect(() => {
    if (!recovery) return
    Effect.runSync(recovery.block(id, active ? reason : null))
    return () => Effect.runSync(recovery.block(id, null))
  }, [recovery, id, reason, active])
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
            onClick={() => {
              if (recovery) Effect.runFork(recovery.reload())
            }}
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
