import { createEffectActor } from "@xstate/effect"
import { Effect, Redacted } from "effect"

import { authClient } from "@/auth/client"

import { AuthIssue } from "./auth-contracts"
import { authNative, authOwner, useAuthActor } from "./auth-owner"
import {
  factorMachine,
  type FactorRequest,
  type FactorMaterial,
} from "./factor.machine"
import { securityError } from "./security-errors"

export function factorRequest(input: FactorRequest) {
  return Effect.gen(function* () {
    const secret = Redacted.value(input.secret)
    const result = yield* authNative<{
      data?: unknown
      error?: { code?: string; message?: string } | null
    }>((signal) => {
      switch (input.action) {
        case "enable":
          return authClient.twoFactor.enable(
            { password: secret.password!, method: "totp" },
            { signal }
          )
        case "disable":
          return authClient.twoFactor.disable(
            { password: secret.password! },
            { signal }
          )
        case "codes":
          return authClient.twoFactor.generateBackupCodes(
            { password: secret.password! },
            { signal }
          )
        case "verify":
          return authClient.twoFactor.verifyTotp(
            { code: secret.code!, trustDevice: false },
            { signal }
          )
      }
    }, "Could not confirm that change. Check your connection and try again. If codes were replaced, generate a new set.")
    if (result.error)
      return yield* Effect.fail(
        new AuthIssue({
          message: securityError(result.error),
          code: result.error.code,
        })
      )
    if (input.action === "enable" || input.action === "codes") {
      const data = result.data
      if (
        !data ||
        typeof data !== "object" ||
        !("backupCodes" in data) ||
        !Array.isArray(data.backupCodes) ||
        !data.backupCodes.every(
          (code): code is string => typeof code === "string"
        )
      )
        return yield* Effect.fail(
          new AuthIssue({
            message:
              "Missing setup information. Generate a new set before continuing.",
          })
        )
      if (
        input.action === "enable" &&
        (!("method" in data) ||
          data.method !== "totp" ||
          !("totpURI" in data) ||
          typeof data.totpURI !== "string")
      )
        return yield* Effect.fail(
          new AuthIssue({ message: "Missing authenticator setup information." })
        )
      return Redacted.make({
        uri:
          "totpURI" in data && typeof data.totpURI === "string"
            ? data.totpURI
            : "",
        codes: data.backupCodes,
      })
    }
    return null
  })
}
export function downloadCodes(material: FactorMaterial) {
  return Effect.gen(function* () {
    const url = yield* Effect.acquireRelease(
      Effect.sync(() =>
        URL.createObjectURL(
          new Blob(
            [
              "Durable Pi recovery codes\nEach code works once.\n\n" +
                Redacted.value(material).codes.join("\n"),
            ],
            { type: "text/plain" }
          )
        )
      ),
      (url) => Effect.sync(() => URL.revokeObjectURL(url))
    )
    yield* Effect.sync(() => {
      const link = document.createElement("a")
      link.href = url
      link.download = "durable-pi-recovery-codes.txt"
      link.click()
    })
    yield* Effect.sleep("1 second")
  }).pipe(Effect.scoped)
}
export function useFactor(
  identity: string,
  enabled: boolean,
  done: () => void
) {
  return useAuthActor(identity, (live) =>
    authOwner((observe) =>
      createEffectActor(
        factorMachine({
          request: (input) => observe(factorRequest(input)),
          done: () =>
            Effect.sync(() => {
              if (live()) done()
            }),
          download: (material) => observe(downloadCodes(material)),
        }),
        { input: { enabled } }
      )
    )
  )
}
