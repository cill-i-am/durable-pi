import { Redacted } from "effect"
import { KeyRound } from "lucide-react"
import { useEffect, useState } from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"

import { useAuthEntry } from "./auth-entry"
import { useAuthBusy } from "./auth-owner"
import { supportsPasskeys } from "./passkey-errors"
export {
  supportsPasskeys,
  passkeyError,
  passkeyErrorCode,
} from "./passkey-errors"

export function PasskeySignIn({
  disabled = false,
  onBusyChange,
  onSignedIn,
}: {
  disabled?: boolean
  onBusyChange?: (busy: boolean) => void
  onSignedIn?: () => Promise<unknown>
}) {
  const [available, setAvailable] = useState<boolean | null>(null)
  const auth = useAuthEntry("passkey", "passkey-sign-in", onSignedIn)
  const pending = auth.snapshot?.matches("requesting") ?? false
  const error = auth.snapshot?.context.error ?? ""
  useEffect(() => setAvailable(supportsPasskeys()), [])
  const dispatch = auth.send
  useEffect(() => {
    dispatch({ type: "BUSY", busy: disabled || available !== true })
  }, [dispatch, disabled, available])
  useAuthBusy(pending, onBusyChange)
  function signIn() {
    auth.send({ type: "SUBMIT", secret: Redacted.make({}) })
  }
  return (
    <div className="flex flex-col gap-3">
      <Button
        variant="outline"
        size="lg"
        className="min-h-11"
        disabled={!auth.actor || disabled || pending || available !== true}
        onClick={() => void signIn()}
      >
        <KeyRound data-icon="inline-start" />
        {pending ? "Waiting for your device…" : "Sign in with a passkey"}
      </Button>
      <p className="text-center text-sm leading-5 text-muted-foreground">
        {available === false
          ? "Passkeys aren’t supported here. Use your password to sign in."
          : "Use a passkey you’ve already added to Pi."}
      </p>
      <p role="status" className="text-sm text-muted-foreground">
        {pending ? "Confirm sign-in on your device." : ""}
      </p>
      {error && (
        <Alert role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}
