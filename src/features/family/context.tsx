import { Schema } from "effect"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react"

import { WorkspaceStartup } from "@/app/workspace-startup"
import { authClient, authFetch } from "@/auth/client"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { FamilySnapshot } from "@/family/contracts"
import { AuthFrame } from "@/features/auth/auth-frame"

const FamilyContext = createContext<{
  family: FamilySnapshot
  refresh: () => Promise<void>
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
  const [family, setFamily] = useState<FamilySnapshot | null>(null)
  const [ended, setEnded] = useState(false)
  const [error, setError] = useState("")
  const refresh = useCallback(async () => {
    try {
      const response = await authFetch("/api/family")
      if (response.status === 403) {
        setEnded(true)
        setFamily(null)
        return
      }
      if (!response.ok) throw new Error("Unavailable")
      setFamily(Schema.decodeUnknownSync(FamilySnapshot)(await response.json()))
      setError("")
    } catch {
      setError("Could not check your family access. Please try again.")
    }
  }, [])
  useEffect(() => {
    void refresh()
    const focus = () => {
      void refresh()
    }
    const timer = window.setInterval(focus, 30_000)
    window.addEventListener("focus", focus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener("focus", focus)
    }
  }, [refresh])
  if (family)
    return <FamilyContext value={{ family, refresh }}>{children}</FamilyContext>
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
            onClick={() =>
              void authClient.signOut().then(() => window.location.assign("/"))
            }
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
