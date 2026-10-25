import { Link, useSearch } from "@tanstack/react-router"
import { Redacted } from "effect"
import { useEffect, useRef, useState } from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { workspaceReturnLink } from "@/navigation/workspace"

import { useAuthEntry } from "./auth-entry"
import { AuthFrame } from "./auth-frame"
import { PasswordInput } from "./password-input"

function BackToSignIn() {
  const { returnTo } = useSearch({ strict: false })
  return (
    <Link
      {...workspaceReturnLink(returnTo ?? "/")}
      data-slot="button"
      className={buttonVariants({ variant: "link" })}
    >
      Back to sign in
    </Link>
  )
}

export function ForgotPassword() {
  const auth = useAuthEntry("forgot", "forgot-password")
  const pending = !auth.snapshot || auth.snapshot.matches("requesting")
  const sent = auth.snapshot?.matches("completed") ?? false
  const error = auth.snapshot?.context.error ?? ""
  function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    auth.send({
      type: "SUBMIT",
      secret: Redacted.make({
        email: String(new FormData(event.currentTarget).get("email")),
      }),
    })
  }
  return (
    <AuthFrame
      title={sent ? "Check your inbox." : "Forgot your password?"}
      description={
        sent
          ? "If this email belongs to your Pi account, a reset link is on its way. It expires in 15 minutes."
          : "Enter your owner email and we'll send a link to choose a new password."
      }
      footer={<BackToSignIn />}
    >
      {sent ? (
        <div role="status" className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Check your spam folder too. If nothing arrives, wait a few minutes
            before trying again.
          </p>
          <Button
            variant="outline"
            onClick={() => auth.send({ type: "RESET" })}
          >
            Try another email
          </Button>
        </div>
      ) : (
        <form onSubmit={submit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="reset-email">Email</FieldLabel>
              <Input
                id="reset-email"
                name="email"
                type="email"
                autoComplete="username"
                placeholder="you@example.com"
                required
                maxLength={254}
                disabled={pending}
              />
            </Field>
            {error && (
              <Alert role="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" size="lg" disabled={pending}>
              {pending ? "Sending…" : "Send reset link"}
            </Button>
          </FieldGroup>
        </form>
      )}
    </AuthFrame>
  )
}

export function ResetPassword() {
  const [link, setLink] = useState<{ token: string | null; revision: number }>({
    token: null,
    revision: 0,
  })
  useEffect(() => {
    const load = () => {
      const value =
        new URLSearchParams(window.location.hash.slice(1)).get("token") ?? ""
      setLink((previous) => ({
        token: /^[A-Za-z0-9_-]{20,128}$/.test(value) ? value : "",
        revision: previous.revision + 1,
      }))
    }
    load()
    window.addEventListener("hashchange", load)
    return () => window.removeEventListener("hashchange", load)
  }, [])
  return <ResetLink key={link.revision} token={link.token} />
}

function ResetLink({ token }: { token: string | null }) {
  const form = useRef<HTMLFormElement>(null)
  const auth = useAuthEntry("reset", "reset-link", () => {
    form.current?.reset()
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname
    )
  })
  const pending = !auth.snapshot || auth.snapshot.matches("requesting")
  const done = auth.snapshot?.matches("completed") ?? false
  const error = auth.snapshot?.context.error ?? ""
  const unavailable = auth.snapshot?.matches("invalid") || token === ""
  function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!token) return
    const values = new FormData(event.currentTarget)
    auth.send({
      type: "SUBMIT",
      secret: Redacted.make({
        token,
        password: String(values.get("password")),
        confirm: String(values.get("confirm")),
      }),
    })
  }
  return (
    <AuthFrame
      title={
        done
          ? "You're ready to return."
          : unavailable
            ? "This link isn't available."
            : "Choose a new password."
      }
      description={
        done
          ? "Your password has been changed and your other sessions have been signed out."
          : unavailable
            ? "The link may have expired or already been used. Request a fresh one to continue."
            : "Use at least 12 characters. A long, unique password works best."
      }
      footer={<BackToSignIn />}
    >
      {done ? (
        <div role="status">Sign in with your new password.</div>
      ) : token === null ? (
        <p role="status">Opening your reset link…</p>
      ) : unavailable ? (
        <Link
          to="/forgot-password"
          data-slot="button"
          className={buttonVariants({})}
        >
          Request a new link
        </Link>
      ) : (
        <form ref={form} onSubmit={submit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="new-password">New password</FieldLabel>
              <PasswordInput
                id="new-password"
                name="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                required
                disabled={pending}
              />
              <FieldDescription>12–128 characters.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="confirm-password">
                Confirm password
              </FieldLabel>
              <PasswordInput
                id="confirm-password"
                name="confirm"
                autoComplete="new-password"
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
            <Button type="submit" size="lg" disabled={pending}>
              {pending ? "Saving…" : "Reset password"}
            </Button>
          </FieldGroup>
        </form>
      )}
    </AuthFrame>
  )
}
