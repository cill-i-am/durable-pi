import { KeyRound } from "lucide-react"
import { useEffect, useState } from "react"

import { authClient } from "@/auth/client"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"

export function supportsPasskeys() {
  return (
    window.isSecureContext &&
    typeof PublicKeyCredential !== "undefined" &&
    !!navigator.credentials
  )
}

export function passkeyErrorCode(error: unknown) {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined
}

export function passkeyError(error: unknown) {
  switch (passkeyErrorCode(error)) {
    case "SESSION_NOT_FRESH":
      return "Sign out and sign in again before adding a passkey."
    case "UNAUTHORIZED":
      return "Your session has ended. Sign in again to continue."
    case "PASSKEY_DEVICE_VERIFICATION_REQUIRED":
      return "Unlock your device with your fingerprint, face or PIN, then try again."
    case "AUTH_CANCELLED":
    case "REGISTRATION_CANCELLED":
    case "ERROR_CEREMONY_ABORTED":
      return "Device confirmation did not finish. Try again when you’re ready, or use your password."
    case "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED":
      return "This passkey is already added. Use it to sign in, or add a different passkey."
    default:
      return "Could not confirm the passkey request. Try again or use your password."
  }
}

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
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  useEffect(() => setAvailable(supportsPasskeys()), [])
  async function signIn() {
    if (pending || disabled || !available) return
    setPending(true)
    onBusyChange?.(true)
    setError("")
    try {
      const result = await authClient.signIn.passkey()
      if (result.error) setError(passkeyError(result.error))
      else if (!result.data)
        setError("Could not confirm sign-in. Try again or use your password.")
      else await onSignedIn?.()
    } catch {
      setError("Could not connect. Try again or use your password.")
    } finally {
      setPending(false)
      onBusyChange?.(false)
    }
  }
  return (
    <div className="flex flex-col gap-3">
      <Button
        variant="outline"
        size="lg"
        className="min-h-11"
        disabled={disabled || pending || available !== true}
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
