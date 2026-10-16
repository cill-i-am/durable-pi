import { QRCodeSVG } from "qrcode.react"
import { useEffect, useState } from "react"

import { authClient } from "@/auth/client"
import { CopyButton } from "@/components/copy-button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "@/components/ui/field"

import { PasswordInput } from "./password-input"
import { securityError } from "./security-errors"
import { VerificationCode } from "./verification-code"

type View =
  | { kind: "manage" }
  | { kind: "password"; action: "enable" | "disable" | "codes" }
  | { kind: "verify"; uri: string; codes: string[] }
  | { kind: "codes"; codes: string[] }

export function FactorSettings({
  onBusyChange,
  onDone,
}: {
  onBusyChange: (busy: boolean) => void
  onDone: () => void
}) {
  const { data: session } = authClient.useSession()
  const [view, setView] = useState<View>(
    session?.user.twoFactorEnabled
      ? { kind: "manage" }
      : { kind: "password", action: "enable" }
  )
  const [password, setPassword] = useState("")
  const [code, setCode] = useState("")
  const [showKey, setShowKey] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  useEffect(() => {
    onBusyChange(pending || view.kind === "codes")
  }, [pending, view.kind, onBusyChange])
  useEffect(() => () => onBusyChange(false), [onBusyChange])
  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setPending(true)
    setError("")
    try {
      if (view.kind === "verify") {
        const result = await authClient.twoFactor.verifyTotp({
          code,
          trustDevice: false,
        })
        if (result.error) {
          setError(securityError(result.error))
          return
        }
        setView({ kind: "codes", codes: view.codes })
        setCode("")
      } else if (view.kind === "password") {
        if (view.action === "enable") {
          const result = await authClient.twoFactor.enable({
            password,
            method: "totp",
          })
          if (result.error) {
            setError(securityError(result.error))
            return
          }
          if (result.data.method !== "totp")
            throw new Error("Missing setup information")
          setView({
            kind: "verify",
            uri: result.data.totpURI,
            codes: result.data.backupCodes,
          })
        } else if (view.action === "codes") {
          const result = await authClient.twoFactor.generateBackupCodes({
            password,
          })
          if (result.error) {
            setError(securityError(result.error))
            return
          }
          setView({ kind: "codes", codes: result.data.backupCodes })
        } else {
          const result = await authClient.twoFactor.disable({ password })
          if (result.error) {
            setError(securityError(result.error))
            return
          }
          onDone()
        }
        setPassword("")
      }
    } catch {
      setError(
        "Could not confirm that change. Check your connection and try again. If codes were replaced, generate a new set."
      )
    } finally {
      setPending(false)
    }
  }
  const title = factorTitle(view)
  return (
    <section className="space-y-6">
      <h2 className="text-xl font-semibold">{title}</h2>
      {view.kind === "manage" ? (
        <div className="space-y-4">
          <p className="text-sm leading-6 text-muted-foreground">
            Your authenticator protects sign-ins. Changing these settings
            requires your password.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => setView({ kind: "password", action: "codes" })}
            >
              Generate new recovery codes
            </Button>
            <Button
              variant="outline"
              onClick={() => setView({ kind: "password", action: "disable" })}
            >
              Turn off two-factor
            </Button>
          </div>
        </div>
      ) : view.kind === "codes" ? (
        <>
          <p className="text-sm leading-6 text-muted-foreground">
            Keep these in your password manager. Each code works once if you
            lose your authenticator. These codes won’t be shown again.
          </p>
          <ul
            className="grid grid-cols-1 gap-3 rounded-lg bg-muted p-5 font-mono text-sm min-[360px]:grid-cols-2"
            aria-label="Recovery codes"
          >
            {view.codes.map((value) => (
              <li key={value}>{value}</li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <CopyButton
              text={view.codes.join("\n")}
              label="Copy recovery codes"
              variant="outline"
              size="default"
            >
              Copy codes
            </CopyButton>
            <Button
              variant="outline"
              onClick={() => {
                const url = URL.createObjectURL(
                  new Blob(
                    [
                      "Durable Pi recovery codes\nEach code works once.\n\n" +
                        view.codes.join("\n"),
                    ],
                    { type: "text/plain" }
                  )
                )
                const link = document.createElement("a")
                link.href = url
                link.download = "durable-pi-recovery-codes.txt"
                link.click()
                setTimeout(() => URL.revokeObjectURL(url), 1000)
              }}
            >
              Download
            </Button>
          </div>
          <Button onClick={onDone}>I’ve saved my codes</Button>
        </>
      ) : (
        <form onSubmit={submit}>
          <FieldGroup>
            {view.kind === "password" ? (
              <>
                <p className="text-sm leading-6 text-muted-foreground">
                  {view.action === "enable"
                    ? "Use your authenticator to protect future sign-ins. Other browsers will be signed out once setup is verified."
                    : view.action === "disable"
                      ? "Future sign-ins will only require your password. This also signs out your other browsers."
                      : "All previous recovery codes will stop working. Save the new set before closing this window."}
                </p>
                <Field>
                  <FieldLabel htmlFor="security-password">
                    Current password
                  </FieldLabel>
                  <PasswordInput
                    id="security-password"
                    autoComplete="current-password"
                    required
                    maxLength={128}
                    disabled={pending}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  {view.action === "enable" && (
                    <FieldDescription>
                      Verification is required before protection turns on.
                    </FieldDescription>
                  )}
                </Field>
              </>
            ) : (
              <>
                <p className="text-sm leading-6 text-muted-foreground">
                  Scan this QR code in 1Password, Apple Passwords, or another
                  authenticator.
                </p>
                <div className="flex flex-col items-center gap-3">
                  <QRCodeSVG
                    value={view.uri}
                    size={180}
                    marginSize={4}
                    title="Scan with your authenticator"
                  />
                  <Button
                    type="button"
                    variant="link"
                    disabled={pending}
                    onClick={() => setShowKey(!showKey)}
                  >
                    {showKey ? "Hide setup key" : "Can’t scan? Show setup key"}
                  </Button>
                  {showKey && (
                    <code className="max-w-full rounded bg-muted p-3 text-xs break-all select-all">
                      {new URL(view.uri).searchParams.get("secret")}
                    </code>
                  )}
                </div>
                <VerificationCode
                  value={code}
                  onChange={setCode}
                  disabled={pending}
                />
              </>
            )}
            {error && (
              <Alert role="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button
              type="submit"
              variant={
                view.kind === "password" && view.action === "disable"
                  ? "destructive"
                  : "default"
              }
              disabled={
                pending || (view.kind === "verify" && code.length !== 6)
              }
            >
              {factorSubmitLabel(view, pending)}
            </Button>
          </FieldGroup>
        </form>
      )}
      {view.kind === "codes" && error && (
        <Alert role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {view.kind !== "codes" && (
        <Button variant="ghost" disabled={pending} onClick={onDone}>
          Back to account security
        </Button>
      )}
    </section>
  )
}

function factorTitle(view: View) {
  return view.kind === "manage"
    ? "Manage two-factor authentication"
    : view.kind === "verify"
      ? "Scan, then verify"
      : view.kind === "codes"
        ? "Save your recovery codes"
        : view.action === "enable"
          ? "Set up two-factor"
          : view.action === "disable"
            ? "Turn off two-factor authentication?"
            : "Replace your recovery codes?"
}

function factorSubmitLabel(
  view: Extract<View, { kind: "password" | "verify" }>,
  pending: boolean
) {
  return pending
    ? view.kind === "verify"
      ? "Verifying…"
      : "Saving…"
    : view.kind === "verify"
      ? "Verify and turn on"
      : view.action === "enable"
        ? "Continue"
        : view.action === "disable"
          ? "Turn off two-factor"
          : "Generate new codes"
}
