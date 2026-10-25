import { Effect, Fiber, Schema } from "effect"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useRef,
} from "react"
import type { SnapshotFrom } from "xstate"

import { WorkspaceStartup } from "@/app/workspace-startup"
import { authClient, authFetch } from "@/auth/client"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { FamilySnapshot } from "@/family/contracts"
import { AuthFrame } from "@/features/auth/auth-frame"
import { ModelQueryProvider } from "@/features/conversation/model-query"

import { makeFamilyAccess } from "./family-access-owner"
import type { familyAccessMachine } from "./family-access.machine"

const FamilyContext = createContext<{
  family: FamilySnapshot
  refresh: () => Promise<void>
  current: () => FamilySnapshot | null
} | null>(null)
export function useFamily() {
  const value = useContext(FamilyContext)
  if (!value)
    throw new Error(
      "Family access must be loaded before opening the workspace."
    )
  return value
}

export function FamilyWorkspace({ children }: { children: React.ReactNode }) {
  const owner = useRef<Effect.Success<
    ReturnType<typeof makeFamilyAccess>
  > | null>(null)
  const [snapshot, setSnapshot] = useState<SnapshotFrom<
    ReturnType<typeof familyAccessMachine>
  > | null>(null)
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const current = yield* makeFamilyAccess({
          read: async (signal) => {
            const response = await authFetch("/api/family", { signal })
            if (!response.ok) {
              await response.body?.cancel()
              if (response.status === 403) return { type: "ended" }
              throw new Error("Unavailable")
            }
            return {
              type: "ready",
              family: Schema.decodeUnknownSync(FamilySnapshot)(
                await response.json()
              ),
            }
          },
          signOut: async () => {
            const result = await authClient.signOut()
            if (result.error)
              throw new Error(result.error.message || "Could not sign out.")
          },
          leave: () => window.location.assign("/"),
        })
        owner.current = current
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            current.actor.subscribe((value) => {
              if (mounted) setSnapshot(value)
            })
          ),
          (subscription) => Effect.sync(() => subscription.unsubscribe())
        )
        if (mounted) setSnapshot(current.actor.getSnapshot())
        yield* Effect.acquireRelease(
          Effect.sync(() => window.addEventListener("focus", current.inspect)),
          () =>
            Effect.sync(() =>
              window.removeEventListener("focus", current.inspect)
            )
        )
        return yield* Effect.never
      }).pipe(Effect.scoped)
    )
    return () => {
      mounted = false
      owner.current?.revoke()
      owner.current = null
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [])
  const refresh = useCallback(
    () =>
      owner.current
        ? Effect.runPromise(owner.current.refresh())
        : Promise.resolve(),
    []
  )
  const current = useCallback(
    () => owner.current?.actor.getSnapshot().context.family ?? null,
    []
  )
  const family = snapshot?.context.family ?? null
  const error = snapshot?.context.error ?? ""
  const ended = snapshot?.matches("ended") || snapshot?.matches("signingOut")
  if (family)
    return (
      <FamilyContext value={{ family, refresh, current }}>
        <ModelQueryProvider>{children}</ModelQueryProvider>
      </FamilyContext>
    )
  if (!ended && !error) return <WorkspaceStartup />
  return (
    <AuthFrame
      title={ended ? "Your family access has ended" : "Opening your workspace"}
      description={
        ended
          ? "You can no longer open this family workspace. Your private work is retained. Ask the family admin for a new invitation."
          : "Checking your account and family access."
      }
    >
      {error && (
        <Alert role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {ended ? (
        <>
          <Button
            render={<a href="/join" aria-label="Continue with an invitation" />}
          >
            Continue with an invitation
          </Button>
          <Button
            variant="outline"
            disabled={snapshot?.matches("signingOut")}
            onClick={() => owner.current?.actor.send({ type: "SIGN_OUT" })}
          >
            Sign out
          </Button>
        </>
      ) : error ? (
        <Button onClick={() => void refresh()}>Try again</Button>
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          Just a moment…
        </p>
      )}
    </AuthFrame>
  )
}
