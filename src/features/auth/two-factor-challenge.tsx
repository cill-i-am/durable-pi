import { Link, useSearch } from "@tanstack/react-router"
import { Redacted } from "effect"
import { useState } from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { authReturnPath, workspaceReturnLink } from "@/navigation/workspace"

import { useAuthEntry } from "./auth-entry"
import { AuthFrame } from "./auth-frame"
import { VerificationCode } from "./verification-code"

export function TwoFactorChallenge() {
  const { returnTo } = useSearch({ strict: false })
  const [code, setCode] = useState("")
  const auth = useAuthEntry("totp", `challenge:${returnTo ?? "/"}`, () => {
    window.location.assign(
      authReturnPath(
        new URLSearchParams(window.location.search).get("returnTo") ?? "/"
      )
    )
  })
  const recovery = auth.snapshot?.context.kind === "backup"
  const pending =
    !auth.snapshot ||
    auth.snapshot.matches("requesting") ||
    auth.snapshot.matches("completed")
  const error = auth.snapshot?.context.error ?? ""
  function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    auth.send({ type: "SUBMIT", secret: Redacted.make({ code }) })
  }
  return (
    <AuthFrame
      title={recovery ? "Use a recovery code" : "Check your authenticator"}
      description={
        recovery
          ? "Each recovery code works once. Keep the rest somewhere safe."
          : "Enter the 6-digit code from your authenticator app to finish signing in."
      }
      footer={
        <>
          <Button
            variant="link"
            disabled={pending}
            onClick={() => {
              auth.send({ type: "MODE", kind: recovery ? "totp" : "backup" })
              setCode("")
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
        </>
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
    </AuthFrame>
  )
}
