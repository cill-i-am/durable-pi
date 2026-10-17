import { Monitor, ShieldCheck } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"

import { authClient } from "@/auth/client"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"

import { FactorSettings } from "./factor-settings"
import { PasskeySettings } from "./passkey-settings"
import { securityError } from "./security-errors"
import { sessionLabel } from "./session-label"

type BrowserSession = typeof authClient.$Infer.Session.session
type Confirmation =
  | { kind: "others" }
  | { kind: "one"; session: BrowserSession }

export function AccountSecurity({
  onClose,
  onPendingChange,
}: {
  onClose: () => void
  onPendingChange?: (pending: boolean) => void
}) {
  const { data: current } = authClient.useSession()
  const [sessions, setSessions] = useState<BrowserSession[]>([])
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [factorLocked, setFactorLocked] = useState(false)
  const [passkeyLocked, setPasskeyLocked] = useState(false)
  const [factorView, setFactorView] = useState(false)
  const [error, setError] = useState("")
  const [freshSignIn, setFreshSignIn] = useState(false)
  const [notice, setNotice] = useState("")
  const [confirm, setConfirm] = useState<Confirmation | null>(null)
  const generation = useRef(0)
  const confirmationHeading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (confirm) confirmationHeading.current?.focus()
  }, [confirm])
  const refresh = useCallback(async () => {
    const request = ++generation.current
    setLoading(true)
    setError("")
    setFreshSignIn(false)
    try {
      const result = await authClient.listSessions()
      if (request !== generation.current) return
      if (result.error) {
        setSessions([])
        setError(securityError(result.error))
        setFreshSignIn(result.error.code === "SESSION_NOT_FRESH")
      } else setSessions(result.data)
    } catch {
      if (request === generation.current)
        setError("Could not load browser sessions. Try refreshing.")
    } finally {
      if (request === generation.current) setLoading(false)
    }
  }, [])
  useEffect(() => {
    void refresh()
    return () => {
      // oxlint-disable-next-line react/exhaustive-deps -- Advance the live request generation so all pending responses become stale.
      generation.current++
    }
  }, [refresh, current?.session.id])
  async function revoke() {
    if (!confirm || locked) return
    setPending(true)
    setError("")
    setNotice("")
    try {
      const result =
        confirm.kind === "others"
          ? await authClient.revokeOtherSessions()
          : await authClient.revokeSession({ token: confirm.session.token })
      if (result.error) setError(securityError(result.error))
      else {
        setConfirm(null)
        setNotice(
          "Browser access revoked. Open connections close within one minute."
        )
        await refresh()
      }
    } catch {
      setError(
        "Could not confirm revocation. Refresh the list before trying again."
      )
    } finally {
      setPending(false)
    }
  }
  useEffect(() => {
    onPendingChange?.(pending || factorLocked || passkeyLocked)
    return () => onPendingChange?.(false)
  }, [pending, factorLocked, passkeyLocked, onPendingChange])
  const others = sessions.filter(
    (session) => session.id !== current?.session.id
  )
  const twoFactorEnabled = !!current?.user.twoFactorEnabled
  const locked = pending || factorLocked || passkeyLocked
  return (
    <Dialog
      open
      dismissible={!locked}
      onOpenChange={(open) => {
        if (!open && !locked) onClose()
      }}
    >
      <DialogContent
        showCloseButton={!locked}
        className="account-security flex max-h-[90dvh] flex-col gap-6 overflow-y-auto p-6 max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-h-dvh max-sm:max-w-none max-sm:translate-0 max-sm:rounded-none sm:max-w-[720px] sm:p-8"
      >
        <header className="space-y-2 pr-8">
          <DialogTitle className="text-2xl leading-8 font-semibold">
            Account security
          </DialogTitle>
          <DialogDescription className="leading-6">
            Protect your account and control where you’re signed in.
          </DialogDescription>
        </header>
        {factorView ? (
          <FactorSettings
            onBusyChange={setFactorLocked}
            onDone={() => {
              setFactorView(false)
              void refresh()
            }}
          />
        ) : (
          <>
            <TwoFactorCard
              enabled={twoFactorEnabled}
              pending={locked}
              onManage={() => setFactorView(true)}
            />
            <PasskeySettings
              disabled={pending || factorLocked}
              onBusyChange={setPasskeyLocked}
            />
            <section
              className="space-y-4"
              aria-labelledby="sessions-heading"
              aria-busy={loading}
            >
              <header className="space-y-1">
                <div className="flex items-center justify-between gap-4">
                  <h2 id="sessions-heading" className="text-xl font-semibold">
                    Browser sessions
                  </h2>
                  <Button
                    variant="ghost"
                    disabled={loading || locked}
                    onClick={() => void refresh()}
                  >
                    Refresh
                  </Button>
                </div>
                <p className="text-sm leading-6 text-muted-foreground">
                  Each entry is a browser session. Device names are inferred.
                </p>
              </header>
              {loading && (
                <p role="status" className="text-sm text-muted-foreground">
                  Loading sessions…
                </p>
              )}
              <ul className="divide-y">
                {[...sessions]
                  .sort(
                    (a, b) =>
                      Number(b.id === current?.session.id) -
                      Number(a.id === current?.session.id)
                  )
                  .map((session) => (
                    <li
                      key={session.id}
                      className="flex items-center gap-4 py-4"
                    >
                      <Monitor className="size-5 shrink-0 text-muted-foreground max-sm:hidden" />
                      <div className="min-w-0 flex-1 space-y-1">
                        <p className="text-sm font-medium">
                          {sessionLabel(session.userAgent)}
                        </p>
                        <p className="text-xs leading-5 text-muted-foreground">
                          Signed in{" "}
                          {new Date(session.createdAt).toLocaleString()}
                          <br />
                          Expires {new Date(session.expiresAt).toLocaleString()}
                        </p>
                      </div>
                      <div className="flex w-26 shrink-0 justify-end">
                        {session.id === current?.session.id ? (
                          <span className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-accent-foreground">
                            This browser
                          </span>
                        ) : (
                          <Button
                            variant="outline"
                            disabled={locked}
                            aria-label={`Sign out ${sessionLabel(session.userAgent)}`}
                            onClick={() => {
                              setError("")
                              setConfirm({ kind: "one", session })
                            }}
                          >
                            Sign out
                          </Button>
                        )}
                      </div>
                    </li>
                  ))}
              </ul>
              {!loading && !error && sessions.length === 0 && (
                <p>No active sessions found. Sign in again to continue.</p>
              )}
            </section>
            {confirm && (
              <section
                className="space-y-4 rounded-lg border p-5"
                aria-label="Confirm browser sign-out"
              >
                <h3
                  ref={confirmationHeading}
                  tabIndex={-1}
                  className="font-semibold outline-none"
                >
                  {confirm.kind === "others"
                    ? "Sign out all other browsers?"
                    : `Sign out ${sessionLabel(confirm.session.userAgent)}?`}
                </h3>
                <p className="text-sm leading-6 text-muted-foreground">
                  Those sessions will need to sign in again. Your agents and
                  saved work will keep running.
                </p>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    disabled={locked}
                    onClick={() => setConfirm(null)}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={locked}
                    onClick={() => void revoke()}
                  >
                    {pending ? "Signing out…" : "Sign out browser"}
                  </Button>
                </div>
              </section>
            )}
            {error && (
              <Alert role="alert">
                <AlertDescription>
                  {error}
                  {freshSignIn && (
                    <Button
                      variant="link"
                      onClick={() => void authClient.signOut()}
                    >
                      Sign out and sign in again
                    </Button>
                  )}
                </AlertDescription>
              </Alert>
            )}
            {notice && (
              <p role="status" className="text-sm text-primary">
                {notice}
              </p>
            )}
            <footer className="flex flex-wrap items-center justify-between gap-4 border-t pt-5">
              <p className="text-xs text-muted-foreground">
                Your agents and saved work keep running.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={locked || loading || !others.length}
                  onClick={() => {
                    setError("")
                    setConfirm({ kind: "others" })
                  }}
                >
                  Sign out other browsers
                </Button>
                <Button variant="outline" disabled={locked} onClick={onClose}>
                  Done
                </Button>
              </div>
            </footer>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function TwoFactorCard({
  enabled,
  pending,
  onManage,
}: {
  enabled: boolean
  pending: boolean
  onManage: () => void
}) {
  return (
    <section
      className="flex flex-wrap items-center gap-4 rounded-lg border p-5 max-sm:grid max-sm:grid-cols-[20px_1fr]"
      aria-labelledby="two-factor-heading"
    >
      <ShieldCheck className="size-5 text-primary" />
      <div className="min-w-0 flex-1 space-y-1">
        <h2 id="two-factor-heading" className="font-semibold">
          Two-factor authentication
        </h2>
        <p className="text-sm leading-6 text-muted-foreground">
          {enabled
            ? "On · Your authenticator protects password sign-ins."
            : "Off · Add an authenticator for an extra layer of protection."}
        </p>
      </div>
      <Button
        className="max-sm:col-span-2 max-sm:w-full"
        variant={enabled ? "outline" : "default"}
        disabled={pending}
        onClick={onManage}
      >
        {enabled ? "Manage" : "Set up two-factor"}
      </Button>
    </section>
  )
}
