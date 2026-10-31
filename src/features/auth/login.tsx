import { Link, useLocation } from "@tanstack/react-router"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { Redacted } from "effect"

import { workspaceReturnPath } from "@/navigation/workspace"

import { useAuthEntry } from "./auth-entry"
import { AuthFrame } from "./auth-frame"
import { PasskeySignIn } from "./passkey-sign-in"
import { PasswordInput } from "./password-input"

export function Login({ sessionError }: { sessionError?: string }) {
  const returnTo = useLocation({
    select: (location) => workspaceReturnPath(location.href),
  })
  const auth = useAuthEntry("login", "login", undefined, sessionError)
  const setup = auth.snapshot?.context.kind === "setup"
  const error = auth.snapshot?.context.error ?? sessionError ?? ""
  const notice = auth.snapshot?.context.notice ?? ""
  const pending =
    !auth.snapshot ||
    auth.snapshot.matches("requesting") ||
    auth.snapshot.context.externalBusy
  function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = Object.fromEntries(new FormData(event.currentTarget))
    auth.send({
      type: "SUBMIT",
      secret: Redacted.make(
        Object.fromEntries(
          Object.entries(values).map(([key, value]) => [key, String(value)])
        )
      ),
    })
  }
  return (
    <AuthFrame
      title={setup ? "Create your account" : "Welcome back"}
      description={
        setup
          ? "Create the owner account with your private setup key."
          : "Sign in to your private workspace."
      }
      footer={
        <Button
          variant="link"
          size="sm"
          disabled={pending}
          onClick={() => {
            auth.send({ type: "MODE", kind: setup ? "login" : "setup" })
          }}
        >
          {setup ? "Back to sign in" : "First time? Set up your account"}
        </Button>
      }
    >
      <form onSubmit={submit}>
        <FieldGroup>
          {setup ? (
            <>
              <Field>
                <FieldLabel htmlFor="name">Your name</FieldLabel>
                <Input
                  id="name"
                  name="name"
                  autoComplete="name"
                  required
                  maxLength={100}
                  disabled={pending}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="setupToken">Setup key</FieldLabel>
                <Input
                  id="setupToken"
                  name="setupToken"
                  type="password"
                  autoComplete="off"
                  required
                  disabled={pending}
                />
                <FieldDescription>
                  From your private deployment configuration.
                </FieldDescription>
              </Field>
            </>
          ) : (
            <Field>
              <FieldLabel htmlFor="email">Email</FieldLabel>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                placeholder="you@example.com"
                required
                disabled={pending}
              />
            </Field>
          )}
          <Field>
            <div className="auth-entry-password-label">
              <FieldLabel htmlFor="password">Password</FieldLabel>
              {!setup && (
                <Link to="/forgot-password" search={{ returnTo }}>
                  Forgot password?
                </Link>
              )}
            </div>
            <PasswordInput
              id="password"
              name="password"
              autoComplete={setup ? "new-password" : "current-password"}
              minLength={12}
              maxLength={128}
              required
              disabled={pending}
            />
          </Field>
          {error && (
            <Alert role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <p
            role="status"
            className="text-sm text-muted-foreground"
            hidden={!notice}
          >
            {notice}
          </p>
          <Button type="submit" disabled={pending} aria-busy={pending}>
            {pending
              ? setup
                ? "Creating account…"
                : "Signing in…"
              : setup
                ? "Create owner account"
                : "Sign in"}
          </Button>
        </FieldGroup>
      </form>
      {!setup && (
        <PasskeySignIn
          disabled={pending}
          onBusyChange={(busy) => auth.send({ type: "BUSY", busy })}
        />
      )}
    </AuthFrame>
  )
}
