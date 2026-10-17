import { Effect, Schema } from "effect"

import type { WebsiteEnv } from "../../../alchemy.run"
import { createAuth, sameOrigin } from "../../auth/server"
import { jsonRequest } from "../../shared/http"
import { familyDirectory } from "./directory"

const InvitationInput = Schema.Struct({
  invitation: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(200)
  ),
})
const VerificationInput = Schema.Struct({
  token: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
})
class InvalidFamilyRequest extends Schema.TaggedError<InvalidFamilyRequest>()(
  "InvalidFamilyRequest",
  {}
) {}
const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  })

export async function familyRequest(
  request: Request,
  env: WebsiteEnv,
  action = ""
) {
  if (request.method === "POST" && !sameOrigin(request, env.APP_URL))
    return json({ error: "Untrusted origin" }, 403)
  try {
    const auth = createAuth(env)
    const family = familyDirectory(env.DB, env.OWNER_EMAIL)
    if (request.method === "GET" && action === "") {
      const session = await auth.api.getSession({
        headers: request.headers,
        query: { disableCookieCache: true, disableRefresh: true },
      })
      if (!session) return json({ error: "Sign in to continue." }, 401)
      await family.bootstrap(session.user.id, session.user.email)
      const access = await family.access(session.user.id)
      if (!access)
        return json(
          {
            code: session.user.emailVerified
              ? "FAMILY_ACCESS_ENDED"
              : "VERIFY_EMAIL",
            error: "Your account does not have family access.",
          },
          403
        )
      return json(await family.snapshot(access))
    }
    if (request.method !== "POST") return json({ error: "Not found" }, 404)
    const parsed = await Effect.runPromise(
      jsonRequest(
        request,
        Schema.Unknown,
        4096,
        () => new InvalidFamilyRequest()
      ).pipe(
        Effect.match({ onFailure: () => null, onSuccess: (body) => ({ body }) })
      )
    )
    if (!parsed)
      return json(
        {
          error:
            "Invalid request. Use a valid invitation or verification link.",
        },
        400
      )
    const { body } = parsed
    if (action === "invitation") {
      const input = Schema.decodeUnknownOption(InvitationInput)(body)
      if (input._tag === "None")
        return json({ error: "Invalid invitation." }, 400)
      const preview = await family.preview(input.value.invitation)
      return preview
        ? json(preview)
        : json({ error: "This invitation is no longer available." }, 404)
    }
    if (action === "verify") {
      const input = Schema.decodeUnknownOption(VerificationInput)(body)
      if (input._tag === "None")
        return json({ error: "Invalid verification link." }, 400)
      const response = await auth.api.verifyEmail({
        query: { token: input.value.token },
        asResponse: true,
      })
      response.headers.set("Cache-Control", "private, no-store")
      return response
    }
    return json({ error: "Not found" }, 404)
  } catch {
    return json(
      { error: "Family access is temporarily unavailable. Please try again." },
      503
    )
  }
}
