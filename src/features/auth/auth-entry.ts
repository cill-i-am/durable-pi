import { createEffectActor } from "@xstate/effect"
import { Effect, Redacted } from "effect"
import { useLayoutEffect, useRef } from "react"

import { authClient } from "@/auth/client"
import { errorMessage } from "@/http/client"

import { AuthIssue } from "./auth-contracts"
import {
  authEntryMachine,
  type EntryKind,
  type EntryRequest,
} from "./auth-entry.machine"
import { authNative, authOwner, useAuthActor } from "./auth-owner"
import { passkeyError } from "./passkey-errors"
import { securityError } from "./security-errors"

const connection = "Could not connect. Check your connection and try again."
export function entryRequest(input: EntryRequest) {
  return Effect.gen(function* () {
    const secret = Redacted.value(input.secret)
    if (input.kind === "setup") {
      const response = yield* authNative(
        (signal) =>
          fetch("/api/setup", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-setup-token": secret.setupToken!,
            },
            body: JSON.stringify({
              name: secret.name,
              password: secret.password,
            }),
            signal,
          }),
        connection
      )
      if (!response.ok) {
        const value = yield* authNative(() => response.json(), connection)
        return yield* Effect.fail(
          new AuthIssue({ message: errorMessage(value) })
        )
      }
      return
    }
    const kind = input.kind
    const result = yield* authNative<{
      data?: unknown
      error?: { status: number; message?: string; code?: string } | null
    }>((signal) => {
      const options = { signal }
      switch (kind) {
        case "login":
          return authClient.signIn.email(
            { email: secret.email!, password: secret.password! },
            options
          )
        case "forgot":
          return authClient.requestPasswordReset(
            { email: secret.email!.trim() },
            options
          )
        case "reset":
          return authClient.resetPassword(
            { newPassword: secret.password!, token: secret.token! },
            options
          )
        case "totp":
          return authClient.twoFactor.verifyTotp(
            { code: secret.code!, trustDevice: false },
            options
          )
        case "backup":
          return authClient.twoFactor.verifyBackupCode(
            { code: secret.code!.trim(), trustDevice: false },
            options
          )
        case "passkey":
          return authClient.signIn.passkey({ fetchOptions: options })
      }
    }, connection)
    if (result.error) {
      const error = result.error
      const code =
        "code" in error && typeof error.code === "string"
          ? error.code
          : undefined
      let message: string
      if (input.kind === "passkey") message = passkeyError(error)
      else if (input.kind === "totp" || input.kind === "backup")
        message = securityError(error)
      else if (input.kind === "forgot")
        message =
          error.status === 429
            ? "Too many requests. Please wait 10 minutes before trying again."
            : "Could not request a reset. Please try again."
      else if (input.kind === "reset")
        message =
          error.status === 429
            ? "Too many attempts. Please wait 10 minutes before trying again."
            : "Could not reset your password. Please try again."
      else message = error.message ?? "Could not sign in"
      return yield* Effect.fail(new AuthIssue({ message, code }))
    }
    if (input.kind === "passkey" && !result.data)
      return yield* Effect.fail(
        new AuthIssue({
          message: "Could not confirm sign-in. Try again or use your password.",
        })
      )
  })
}
export function useAuthEntry(
  kind: EntryKind,
  identity: string,
  completed: (input: EntryRequest) => void | Promise<unknown> = () => {},
  error = ""
) {
  const callback = useRef(completed)
  useLayoutEffect(() => {
    callback.current = completed
  }, [completed])
  return useAuthActor(identity, (live) =>
    authOwner((observe) =>
      createEffectActor(
        authEntryMachine({
          request: (input) => observe(entryRequest(input)),
          completed: (input) =>
            observe(
              Effect.suspend(() =>
                live()
                  ? authNative(
                      () => Promise.resolve(callback.current(input)),
                      connection
                    ).pipe(Effect.asVoid)
                  : Effect.void
              )
            ),
        }),
        { input: { kind, error } }
      )
    )
  )
}
