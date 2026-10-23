import { isAPIError } from "better-auth/api"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import { Schema } from "effect"

import { familyDirectory } from "../../family/adapters/directory"
import { nativeOperation } from "../../shared/interop"
import { user } from "../schema"
import { createAuth, type AuthEnv } from "../server"

const keyId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200)
)
const Action = Schema.Union([
  Schema.Struct({ action: Schema.Literal("read") }),
  Schema.Struct({ action: Schema.Literal("setup") }),
  Schema.Struct({ action: Schema.Literal("remove"), id: keyId }),
  Schema.Struct({
    action: Schema.Literal("rename"),
    id: keyId,
    name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  }),
])
export class PasskeyActionFailed extends Schema.TaggedError<PasskeyActionFailed>()(
  "PasskeyActionFailed",
  { message: Schema.String }
) {}

/** Identity comes from the private actor. The model receives labels and row
 * IDs, never public keys, credential IDs, challenges or session tokens. */
export function passkeyAgentAction(
  env: AuthEnv,
  userId: string,
  input: unknown
) {
  return nativeOperation(
    async () => {
      const action = Schema.decodeUnknownSync(Action)(input)
      const directory = familyDirectory(env.DB, env.OWNER_EMAIL)
      if (!(await directory.access(userId)))
        throw new PasskeyActionFailed({
          message: "Your family access has ended.",
        })
      const url = new URL("/settings/security", env.APP_URL).href
      if (action.action === "setup")
        return {
          status: "device_confirmation_required",
          url,
          instructions:
            "Open Account security, choose Add passkey and confirm on your device. No passkey has been created yet.",
        }
      const principal = await drizzle(env.DB)
        .select()
        .from(user)
        .where(eq(user.id, userId))
        .get()
      if (!principal)
        throw new PasskeyActionFailed({
          message: "Could not confirm your account.",
        })
      const auth = createAuth(env, false, undefined, principal)
      const headers = new Headers({ origin: env.APP_URL })
      const keys = await auth.api.listPasskeys({ headers })
      if (action.action === "read")
        return {
          keys: keys.map((key) => ({
            id: key.id,
            name: key.name || "Passkey",
            createdAt: key.createdAt?.toISOString() ?? null,
          })),
          setupUrl: url,
        }
      const selected = keys.find((key) => key.id === action.id)
      if (!selected)
        throw new PasskeyActionFailed({
          message:
            "That passkey was not found on your account. Read your passkeys again.",
        })
      if (action.action === "rename") {
        const name = action.name.trim()
        if (!name)
          throw new PasskeyActionFailed({
            message: "Choose a name for this passkey.",
          })
        await auth.api.updatePasskey({
          headers,
          body: { id: selected.id, name },
        })
        return { status: "renamed", name }
      }
      await auth.api.deletePasskey({ headers, body: { id: selected.id } })
      return {
        status: "removed",
        name: selected.name || "Passkey",
        existingBrowserSessionsRetained: true,
      }
    },
    (cause) => {
      const known = Schema.decodeUnknownOption(PasskeyActionFailed)(cause)
      if (known._tag === "Some") return known.value
      if (isAPIError(cause))
        return new PasskeyActionFailed({ message: cause.message })
      return new PasskeyActionFailed({
        message:
          "Could not confirm the change. Read your passkeys before retrying.",
      })
    }
  )
}
