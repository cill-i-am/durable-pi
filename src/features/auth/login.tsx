import { useState } from "react"
import { ArrowUp, LockKeyhole } from "lucide-react"
import { authClient } from "@/auth/client"
import { errorMessage } from "@/http/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "@/components/ui/field"
import { Alert, AlertDescription } from "@/components/ui/alert"

export function PiMark() {
  return (
    <span className="pi-mark" aria-label="Pi">
      π
    </span>
  )
}
export function Login({ sessionError }: { sessionError?: string }) {
  const [setup, setSetup] = useState(false),
    [error, setError] = useState(sessionError ?? ""),
    [pending, setPending] = useState(false)
  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setError("")
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
        setError("Account created. Sign in with your owner email and password.")
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
    <main className="login-page">
      <div className="login-brand">
        <PiMark />
        <span>Pi</span>
        <span className="login-caption">A little more continuity.</span>
      </div>
      <section className="login-panel">
        <LockKeyhole className="login-lock" />
        <h1>{setup ? "Make yourself at home." : "Welcome back."}</h1>
        <p className="text-muted-foreground">
          {setup
            ? "Create the single owner account using your private setup key."
            : "Sign in to your private, continuous chat."}
        </p>
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
                />
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="password">Password</FieldLabel>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete={setup ? "new-password" : "current-password"}
                minLength={12}
                maxLength={128}
                required
              />
            </Field>
            {error && (
              <Alert>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" disabled={pending}>
              {pending
                ? "Please wait…"
                : setup
                  ? "Create owner account"
                  : "Sign in"}
              <ArrowUp data-icon="inline-end" />
            </Button>
          </FieldGroup>
        </form>
        <Button
          variant="link"
          size="sm"
          onClick={() => {
            setSetup(!setup)
            setError("")
          }}
        >
          {setup ? "Back to sign in" : "First time? Set up your account"}
        </Button>
      </section>
      <footer className="login-footer">
        Private by default. Your conversation stays yours.
      </footer>
    </main>
  )
}
