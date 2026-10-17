import { Link, useLocation } from "@tanstack/react-router"
import { useState } from "react"

import { authClient } from "@/auth/client"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { errorMessage } from "@/http/client"
import { workspaceReturnPath } from "@/navigation/workspace"

import { AuthFrame } from "./auth-frame"
import { PasskeySignIn } from "./passkey-sign-in"
import { PasswordInput } from "./password-input"

export function Login({ sessionError }: { sessionError?: string }) {
  const returnTo = useLocation({
    select: (location) => workspaceReturnPath(location.href),
  })
  const [setup, setSetup] = useState(false),
    [error, setError] = useState(sessionError ?? ""),
    [notice, setNotice] = useState(""),
    [pending, setPending] = useState(false)
  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setError("")
    setNotice("")
    setPending(true)
    const data = new FormData(event.currentTarget)
    try {
      if (setup) {
        const response = await fetch("/api/setup", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-setup-token": String(data.get("setupToken")),
          },
          body: JSON.stringify({
            name: data.get("name"),
            password: data.get("password"),
          }),
        })
        if (!response.ok) throw new Error(errorMessage(await response.json()))
        setSetup(false)
        setNotice(
          "Account created. Sign in with your owner email and password."
        )
      } else {
        const result = await authClient.signIn.email({
          email: String(data.get("email")),
          password: String(data.get("password")),
        })
        if (result.error)
          throw new Error(result.error.message ?? "Could not sign in")
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not sign in")
    } finally {
      setPending(false)
    }
  }
  return (
    <AuthFrame
      title={setup ? "Make yourself at home." : "Welcome back."}
      description={
        setup
          ? "Create the single owner account using your private setup key."
          : "Sign in to your personal workspace."
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
            <div className="login-password-label">
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
          <Button type="submit" size="lg" disabled={pending}>
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
      {!setup && <PasskeySignIn disabled={pending} onBusyChange={setPending} />}
      <Button
        variant="link"
        size="sm"
        disabled={pending}
        onClick={() => {
          setSetup(!setup)
          setError("")
          setNotice("")
        }}
      >
        {setup ? "Back to sign in" : "First time? Set up your account"}
      </Button>
    </AuthFrame>
  )
}
