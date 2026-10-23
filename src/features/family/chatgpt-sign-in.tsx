import { ExternalLink } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { agentApi } from "@/http/client"
import type { ChatGPTSignInPending } from "@/inference/adapters/chatgpt-sign-in"

const account = agentApi("home")
export function ChatGPTReconnect({
  defaultEmail,
  onConnected,
  onPendingChange,
}: {
  defaultEmail: string
  onConnected: () => Promise<void>
  onPendingChange?: (pending: boolean) => void
}) {
  const [email, setEmail] = useState(defaultEmail)
  const [attempt, setAttempt] = useState<ChatGPTSignInPending | null>(null)
  const [address, setAddress] = useState("")
  const [error, setError] = useState("")
  const [saved, setSaved] = useState("")
  const [working, setWorking] = useState(false)
  const [loading, setLoading] = useState(true)
  const [requestError, setRequestError] = useState(false)
  useEffect(() => {
    onPendingChange?.(working || address.length > 0 || requestError)
    return () => onPendingChange?.(false)
  }, [working, address, requestError, onPendingChange])
  const returnField = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const controller = new AbortController()
    void account<{ pending: ChatGPTSignInPending | null }>(
      "model-account",
      undefined,
      controller.signal
    )
      .then((value) => {
        if (!controller.signal.aborted) setAttempt(value.pending)
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError(
            "Could not restore the previous sign-in. Start again to reconnect."
          )
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [])
  useEffect(() => {
    if (attempt && !working) returnField.current?.focus()
  }, [attempt, working, error])
  async function start() {
    setWorking(true)
    setRequestError(false)
    setError("")
    setSaved("")
    // Open synchronously so browser popup policies can preserve the user's tab.
    const tab = window.open("about:blank", "_blank")
    if (tab) tab.opener = null
    try {
      const next = await account<ChatGPTSignInPending>("model-account", {
        action: "start",
        email,
      })
      setAttempt(next)
      if (tab) tab.location.replace(next.authorizationUrl)
    } catch (cause) {
      setRequestError(true)
      tab?.close()
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not start sign-in. Try again."
      )
    } finally {
      setWorking(false)
    }
  }
  async function finish() {
    if (!attempt) return
    setWorking(true)
    setRequestError(false)
    setError("")
    const returned = address
    setAddress("")
    try {
      const result = await account<{ status: "connected"; email: string }>(
        "model-account",
        { action: "finish", id: attempt.id, address: returned }
      )
      await onConnected()
      setAttempt(null)
      setSaved(
        `ChatGPT connected as ${result.email}. Your family uses this connection.`
      )
    } catch (cause) {
      setRequestError(true)
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not finish sign-in. Start again."
      )
    } finally {
      setWorking(false)
    }
  }
  async function cancel() {
    setWorking(true)
    setRequestError(false)
    setError("")
    setAddress("")
    try {
      await account("model-account", { action: "cancel" })
      setAttempt(null)
    } catch {
      setRequestError(true)
      setError("Could not reset sign-in. Try again.")
    } finally {
      setWorking(false)
    }
  }
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
            onClick={() => setSaved("")}
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
                setError("")
                setRequestError(false)
              }}
              placeholder="http://127.0.0.1:…/auth/callback?…"
              className="h-11 min-w-0 text-base sm:text-sm"
              aria-describedby={
                error
                  ? "chatgpt-return-help chatgpt-sign-in-error"
                  : "chatgpt-return-help"
              }
              aria-invalid={error ? true : undefined}
              disabled={working}
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
              disabled={working}
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
            setError("")
            setRequestError(false)
          }}
        >
          {requestError ? "Dismiss error" : "Discard return address"}
        </Button>
      )}
    </div>
  )
}
