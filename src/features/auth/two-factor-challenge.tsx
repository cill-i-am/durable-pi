import { Link, useSearch } from "@tanstack/react-router"
import { useState } from "react"

import { authClient } from "@/auth/client"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { authReturnPath, workspaceReturnLink } from "@/navigation/workspace"

import { AuthFrame } from "./auth-frame"
import { securityError } from "./security-errors"
import { VerificationCode } from "./verification-code"

export function TwoFactorChallenge() {
  const { returnTo } = useSearch({ strict: false })
  const [recovery, setRecovery] = useState(false)
  const [code, setCode] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setPending(true)
    setError("")
    try {
      const result = recovery
        ? await authClient.twoFactor.verifyBackupCode({
            code: code.trim(),
            trustDevice: false,
          })
        : await authClient.twoFactor.verifyTotp({ code, trustDevice: false })
      if (result.error) setError(securityError(result.error))
      else
        window.location.assign(
          authReturnPath(
            new URLSearchParams(window.location.search).get("returnTo") ?? "/"
          )
        )
    } catch {
      setError("Could not connect. Check your connection and try again.")
    } finally {
      setPending(false)
    }
  }
  return (
    <AuthFrame
      title={recovery ? "Use a recovery code" : "Check your authenticator"}
      description={
        recovery
          ? "Each recovery code works once. Keep the rest somewhere safe."
          : "Enter the 6-digit code from your authenticator app to finish signing in."
      }
    >
      <form onSubmit={submit}>
        <FieldGroup>
          {recovery ? (
            <Field>
              <FieldLabel htmlFor="recovery-code">Recovery code</FieldLabel>
              <Input
                id="recovery-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={64}
                required
                disabled={pending}
              />
            </Field>
          ) : (
            <VerificationCode
              value={code}
              onChange={setCode}
              disabled={pending}
            />
          )}
          {error && (
            <Alert role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button
            type="submit"
            size="lg"
            disabled={pending || (recovery ? !code.trim() : code.length !== 6)}
          >
            {pending
              ? "Verifying…"
              : recovery
                ? "Use code and sign in"
                : "Verify and sign in"}
          </Button>
        </FieldGroup>
      </form>
      <Button
        variant="link"
        disabled={pending}
        onClick={() => {
          setRecovery(!recovery)
          setCode("")
          setError("")
        }}
      >
        {recovery ? "Use your authenticator" : "Use a recovery code"}
      </Button>
      <Link
        {...(returnTo === "/join"
          ? { to: "/join" as const }
          : workspaceReturnLink(returnTo ?? "/"))}
        className="text-center text-sm text-muted-foreground underline underline-offset-4"
      >
        Back to sign in
      </Link>
    </AuthFrame>
  )
}
