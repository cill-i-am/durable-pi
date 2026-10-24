import { Effect, Fiber, Redacted } from "effect"
import { ExternalLink } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { SnapshotFrom } from "xstate"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { agentApi } from "@/http/client"

import { useFamily } from "./context"
import { makeModelSignIn } from "./model-sign-in-owner"
import type { modelSignInMachine } from "./model-sign-in.machine"

const account = agentApi("home")
function useModelSignIn(
  defaultEmail: string,
  onConnected: () => Promise<void>
) {
  const { family, current } = useFamily()
  const authority = `${family.id}:${family.members.find((member) => member.role === "owner")?.id}`
  const [email, setEmail] = useState(defaultEmail)
  const [address, setAddress] = useState("")
  const [snapshot, setSnapshot] = useState<SnapshotFrom<
    ReturnType<typeof modelSignInMachine>
  > | null>(null)
  const owner = useRef<Effect.Success<
    ReturnType<typeof makeModelSignIn>
  > | null>(null)
  const returnField = useRef<HTMLInputElement>(null)
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const value = yield* makeModelSignIn({
          account: (body, signal) => account("model-account", body, signal),
          connected: onConnected,
          authorized: () => {
            const latest = current()
            return (
              latest?.role === "owner" &&
              `${latest.id}:${latest.members.find((member) => member.role === "owner")?.id}` ===
                authority
            )
          },
          popup: () => window.open("about:blank", "_blank"),
        })
        if (!mounted) {
          value.revoke()
          return
        }
        owner.current = value
        const subscription = value.actor.subscribe((state) => {
          if (mounted) setSnapshot(state)
        })
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => subscription.unsubscribe())
        )
        setSnapshot(value.actor.getSnapshot())
        return yield* Effect.never
      }).pipe(Effect.scoped)
    )
    return () => {
      mounted = false
      owner.current?.revoke()
      owner.current = null
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [authority, current, onConnected])
  const attempt = snapshot?.context.attempt ?? null
  const error = snapshot?.context.error ?? ""
  const saved = snapshot?.context.connected
    ? `ChatGPT connected as ${snapshot.context.connected}. Your family uses this connection.`
    : ""
  const loading = !snapshot || snapshot.matches("restoring")
  const working =
    !!snapshot &&
    ["starting", "exchanging", "reconciling", "cancelling"].some((state) =>
      snapshot.matches(state as "starting")
    )
  const expired = !!snapshot?.matches("expired")
  useEffect(() => {
    if (!attempt || working || expired) return
    const field = returnField.current
    if (!field) return
    field.focus()
    // Removing the start button lets the drawer restore focus to its popup on
    // the next frame. Reconcile after that restoration, unless the user chose
    // another control. Both frames belong to this waiting state.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const active = document.activeElement
        if (
          owner.current?.actor.getSnapshot().matches("waiting") &&
          (active === document.body ||
            active === field.closest('[role="dialog"]'))
        )
          field.focus()
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [attempt, working, expired, error])
  function start() {
    owner.current?.start(email)
  }
  function finish() {
    const returned = address
    setAddress("")
    owner.current?.actor.send({
      type: "FINISH",
      address: Redacted.make(returned),
    })
  }
  function cancel() {
    setAddress("")
    owner.current?.actor.send({ type: "CANCEL" })
  }
  return {
    email,
    setEmail,
    address,
    setAddress,
    attempt,
    error,
    requestError: snapshot?.context.requestError ?? false,
    saved,
    loading,
    working,
    expired,
    returnField,
    start,
    finish,
    cancel,
    owner,
  }
}
export function ChatGPTReconnect({
  defaultEmail,
  onConnected,
  onPendingChange,
}: {
  defaultEmail: string
  onConnected: () => Promise<void>
  onPendingChange?: (pending: boolean) => void
}) {
  const {
    email,
    setEmail,
    address,
    setAddress,
    attempt,
    error,
    requestError,
    saved,
    loading,
    working,
    expired,
    returnField,
    start,
    finish,
    cancel,
    owner,
  } = useModelSignIn(defaultEmail, onConnected)
  useEffect(() => {
    onPendingChange?.(working || address.length > 0 || requestError)
    return () => onPendingChange?.(false)
  }, [working, address, requestError, onPendingChange])
  const failure = error && (
    <Alert id="chatgpt-sign-in-error" role="alert">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  )
  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
      <p role="status" className="settings-description">
        {saved ||
          (loading
            ? "Checking for an unfinished sign-in…"
            : "Sign in to ChatGPT, then paste the final return address here to finish.")}
      </p>
      {saved ? (
        <div className="flex flex-wrap gap-3">
          <Button
            className="h-11"
            render={<a href="/agents/home" aria-label="Back to chat" />}
          >
            Back to chat
          </Button>
          <Button
            variant="outline"
            className="h-11"
            onClick={() => owner.current?.actor.send({ type: "AGAIN" })}
          >
            Sign in again
          </Button>
        </div>
      ) : attempt ? (
        <form
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void finish()
          }}
        >
          <div className="flex flex-col items-start gap-2">
            <h3>Finish connecting ChatGPT</h3>
            <p>
              After signing in, the last page may say it can’t connect. That’s
              expected for this setup.
            </p>
            <Button
              variant="outline"
              className="h-11"
              render={
                <a
                  href={attempt.authorizationUrl}
                  aria-label="Open ChatGPT sign-in"
                  target="_blank"
                  rel="noopener noreferrer"
                  referrerPolicy="no-referrer"
                />
              }
            >
              Open ChatGPT sign-in <ExternalLink />
            </Button>
          </div>
          <ol className="list-inside list-decimal space-y-2 text-sm">
            <li>Copy the full address from your browser’s address bar.</li>
            <li>Return to this tab and paste it below.</li>
          </ol>
          <div className="flex min-w-0 flex-col gap-2">
            <Label htmlFor="chatgpt-return-address">Return address</Label>
            <Input
              ref={returnField}
              id="chatgpt-return-address"
              type="url"
              required
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="none"
              maxLength={8192}
              value={address}
              onChange={(event) => {
                setAddress(event.target.value)
                owner.current?.actor.send({ type: "EDIT" })
              }}
              placeholder="http://127.0.0.1:…/auth/callback?…"
              className="h-11 min-w-0 text-base sm:text-sm"
              aria-describedby={
                error
                  ? "chatgpt-return-help chatgpt-sign-in-error"
                  : "chatgpt-return-help"
              }
              aria-invalid={error ? true : undefined}
              disabled={working || expired}
            />
            <p id="chatgpt-return-help">
              Use this field only. Keep the address out of chat messages. Finish
              within 10 minutes of starting sign-in.
            </p>
          </div>
          {failure}
          <div className="flex flex-wrap gap-3">
            <Button
              type="submit"
              className="h-11"
              disabled={working || expired}
              aria-busy={working}
            >
              {working ? "Connecting…" : "Finish connection"}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              disabled={working}
              onClick={() => void cancel()}
            >
              Start again
            </Button>
          </div>
        </form>
      ) : (
        <form
          className="flex flex-col items-start gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void start()
          }}
        >
          <div className="flex w-full max-w-sm flex-col gap-2">
            <Label htmlFor="chatgpt-email">ChatGPT email</Label>
            <Input
              id="chatgpt-email"
              type="email"
              required
              autoComplete="email"
              maxLength={254}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="Your ChatGPT account email"
              disabled={working || loading}
              className="h-11 text-base sm:text-sm"
            />
          </div>
          {failure}
          <Button
            type="submit"
            className="h-11 bg-foreground text-background hover:bg-foreground/90"
            disabled={working || loading}
            aria-busy={working}
          >
            {working ? "Opening ChatGPT…" : "Sign in with ChatGPT"}
          </Button>
          <p>Only you need to sign in. Your family uses this connection.</p>
        </form>
      )}
      {!working && (address.length > 0 || requestError) && (
        <Button
          type="button"
          variant="ghost"
          className="self-start"
          onClick={() => {
            setAddress("")
            owner.current?.actor.send({ type: "EDIT" })
          }}
        >
          {requestError ? "Dismiss error" : "Discard return address"}
        </Button>
      )}
    </div>
  )
}
