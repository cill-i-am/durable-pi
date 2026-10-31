import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import { Redacted } from "effect"
import { KeyRound } from "lucide-react"
import { useEffect, useState } from "react"

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
    <div className="auth-entry-passkey">
      <Button
        variant="outline"
        className="w-full"
        aria-busy={pending}
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
      <p
        role="status"
        className="text-sm text-muted-foreground"
        hidden={!pending}
      >
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
