import { useEffect, useRef, useState } from "react"
import { workspaceReturnLink } from "@/navigation/workspace"
import { Link, useSearch } from "@tanstack/react-router"
import { authClient } from "@/auth/client"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
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
  const [pending, setPending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState("")
  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setError("")
    setPending(true)
    const email = String(new FormData(event.currentTarget).get("email")).trim()
    try {
      const result = await authClient.requestPasswordReset({ email })
      if (result.error) {
        setError(
          result.error.status === 429
            ? "Too many requests. Please wait 10 minutes before trying again."
            : "Could not request a reset. Please try again."
        )
      } else setSent(true)
    } catch {
      setError("Could not connect. Check your connection and try again.")
    } finally {
      setPending(false)
    }
  }
  return (
    <AuthFrame
      title={sent ? "Check your inbox." : "Forgot your password?"}
      description={
        sent
          ? "If this email belongs to your Pi account, a reset link is on its way. It expires in 15 minutes."
          : "Enter your owner email and we'll send a link to choose a new password."
      }
    >
      {sent ? (
        <div role="status" className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Check your spam folder too. If nothing arrives, wait a few minutes
            before trying again.
          </p>
          <Button variant="outline" onClick={() => setSent(false)}>
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
      <BackToSignIn />
    </AuthFrame>
  )
}

export function ResetPassword() {
  const [token, setToken] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [done, setDone] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const [error, setError] = useState("")
  const linkVersion = useRef(0)
  useEffect(() => {
    const loadLink = () => {
      linkVersion.current++
      const value =
        new URLSearchParams(window.location.hash.slice(1)).get("token") ?? ""
      setToken(/^[A-Za-z0-9_-]{20,128}$/.test(value) ? value : "")
      setPending(false)
      setDone(false)
      setInvalid(false)
      setError("")
    }
    loadLink()
    window.addEventListener("hashchange", loadLink)
    return () => {
      linkVersion.current++
      window.removeEventListener("hashchange", loadLink)
    }
  }, [])
  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending || !token) return
    const form = event.currentTarget
    const data = new FormData(form)
    const password = String(data.get("password"))
    if (password !== data.get("confirm")) {
      setError("Your passwords don't match.")
      return
    }
    setError("")
    setPending(true)
    const version = linkVersion.current
    try {
      const result = await authClient.resetPassword({
        newPassword: password,
        token,
      })
      if (version !== linkVersion.current) return
      if (result.error) {
        if (result.error.code === "INVALID_TOKEN") setInvalid(true)
        else
          setError(
            result.error.status === 429
              ? "Too many attempts. Please wait 10 minutes before trying again."
              : "Could not reset your password. Please try again."
          )
      } else {
        form.reset()
        window.history.replaceState(
          window.history.state,
          "",
          window.location.pathname
        )
        setToken("")
        setDone(true)
      }
    } catch {
      if (version === linkVersion.current)
        setError("Could not connect. Check your connection and try again.")
    } finally {
      if (version === linkVersion.current) setPending(false)
    }
  }
  const unavailable = invalid || token === ""
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
        <form onSubmit={submit}>
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
      <BackToSignIn />
    </AuthFrame>
  )
}
