import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import { DataLoading } from "@workspace/ui/components/data-loading"
import { Monitor, ShieldCheck } from "lucide-react"
import { useEffect, useRef, type ReactNode } from "react"

import { authClient } from "@/auth/client"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"

import { useAuthBusy } from "./auth-owner"
import { FactorSettings } from "./factor-settings"
import { PasskeySettings } from "./passkey-settings"
import { useSecurity } from "./security-owner"
import { sessionLabel } from "./session-label"

function securityProjection(state: ReturnType<typeof useSecurity>["snapshot"]) {
  if (!state)
    return {
      sessions: [],
      loading: true,
      pending: false,
      factorLocked: false,
      passkeyLocked: false,
      factorView: false,
      error: "",
      freshSignIn: false,
      notice: "",
      confirm: null,
      readFailed: false,
    }
  const context = state.context
  return {
    sessions: context.sessions,
    loading: state.matches("loading"),
    pending:
      state.matches("revoking") ||
      state.matches("signingOut") ||
      state.matches("signedOut"),
    factorLocked: context.factorBusy,
    passkeyLocked: context.passkeyBusy,
    factorView: context.factorView,
    error: context.error,
    freshSignIn: context.freshSignIn,
    notice: context.notice,
    confirm: context.confirm,
    readFailed: context.readFailed,
  }
}
function useSecurityView(
  onClose: () => void,
  onPendingChange?: (pending: boolean) => void
) {
  const { data: current } = authClient.useSession()
  const auth = useSecurity(current?.session.id ?? "signed-out", onClose)
  const {
    sessions,
    loading,
    pending,
    factorLocked,
    passkeyLocked,
    factorView,
    error,
    freshSignIn,
    notice,
    confirm,
    readFailed,
  } = securityProjection(auth.snapshot)
  const confirmationHeading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (confirm) confirmationHeading.current?.focus()
  }, [confirm])
  useAuthBusy(pending || factorLocked || passkeyLocked, onPendingChange)
  const refresh = () => auth.send({ type: "REFRESH" })
  const revoke = () => auth.send({ type: "REVOKE" })
  const close = () => auth.send({ type: "CLOSE" })
  const others = sessions.filter(
    (session) => session.id !== current?.session.id
  )
  const twoFactorEnabled = !!current?.user.twoFactorEnabled
  const locked = pending || factorLocked || passkeyLocked || !auth.actor
  return {
    auth,
    current,
    sessions,
    loading,
    pending,
    factorLocked,
    factorView,
    error,
    freshSignIn,
    notice,
    confirm,
    readFailed,
    confirmationHeading,
    refresh,
    revoke,
    close,
    others,
    twoFactorEnabled,
    locked,
  }
}

export function AccountSecurity({
  onClose,
  onPendingChange,
  embedded,
}: {
  onClose: () => void
  onPendingChange?: (pending: boolean) => void
  embedded?: boolean
}) {
  const {
    auth,
    current,
    sessions,
    loading,
    pending,
    factorLocked,
    factorView,
    error,
    freshSignIn,
    notice,
    confirm,
    readFailed,
    confirmationHeading,
    refresh,
    revoke,
    close,
    others,
    twoFactorEnabled,
    locked,
  } = useSecurityView(onClose, onPendingChange)
  return (
    <AccountSecurityFrame embedded={embedded} locked={locked} onClose={close}>
      {factorView ? (
        <FactorSettings
          onBusyChange={(busy) =>
            auth.send({ type: "CHILD_BUSY", child: "factor", busy })
          }
          onDone={() => {
            auth.send({ type: "FACTOR", open: false })
          }}
        />
      ) : (
        <>
          <TwoFactorCard
            enabled={twoFactorEnabled}
            pending={locked}
            onManage={() => auth.send({ type: "FACTOR", open: true })}
          />
          <PasskeySettings
            disabled={pending || factorLocked}
            onBusyChange={(busy) =>
              auth.send({ type: "CHILD_BUSY", child: "passkey", busy })
            }
          />
          <section
            className="space-y-4"
            aria-labelledby="sessions-heading"
            aria-busy={loading}
          >
            <header className="space-y-1">
              <div className="flex items-center justify-between gap-4">
                <h2 id="sessions-heading" className="text-md font-semibold">
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
              <DataLoading loading label="Loading browser sessions" />
            )}
            <ul className="divide-y">
              {[...sessions]
                .sort(
                  (a, b) =>
                    Number(b.id === current?.session.id) -
                    Number(a.id === current?.session.id)
                )
                .map((session) => (
                  <li key={session.id} className="flex items-center gap-4 py-4">
                    <Monitor className="size-5 shrink-0 text-muted-foreground max-sm:hidden" />
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="text-sm font-medium">
                        {sessionLabel(session.userAgent)}
                      </p>
                      <p className="text-xs leading-5 text-muted-foreground">
                        Signed in {new Date(session.createdAt).toLocaleString()}
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
                          disabled={locked || loading || readFailed}
                          aria-label={`Sign out ${sessionLabel(session.userAgent)}`}
                          onClick={() => {
                            auth.send({
                              type: "ASK",
                              confirmation: { kind: "one", session },
                            })
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
                Those sessions will need to sign in again. Your assistants and
                saved work will keep running.
              </p>
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  disabled={locked}
                  onClick={() => auth.send({ type: "CANCEL" })}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  disabled={locked || readFailed}
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
                    disabled={locked}
                    onClick={() => auth.send({ type: "SIGN_OUT" })}
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
              Your assistants and saved work keep running.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={locked || loading || readFailed || !others.length}
                onClick={() => {
                  auth.send({ type: "ASK", confirmation: { kind: "others" } })
                }}
              >
                Sign out other browsers
              </Button>
              {!embedded && (
                <Button variant="outline" disabled={locked} onClick={close}>
                  Done
                </Button>
              )}
            </div>
          </footer>
        </>
      )}
    </AccountSecurityFrame>
  )
}

function AccountSecurityFrame({
  embedded = false,
  locked,
  onClose,
  children,
}: {
  embedded?: boolean
  locked: boolean
  onClose: () => void
  children: ReactNode
}) {
  const Heading = embedded ? "h2" : DialogTitle
  const Description = embedded ? "p" : DialogDescription
  const content = (
    <>
      <header className="space-y-2 pr-8">
        <Heading className="text-2xl leading-8 font-semibold">
          Account security
        </Heading>
        <Description className="text-sm leading-6 text-muted-foreground">
          Protect your account and control where you’re signed in.
        </Description>
      </header>
      {children}
    </>
  )
  if (embedded) {
    return <section className="account-security">{content}</section>
  }
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
        {content}
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
