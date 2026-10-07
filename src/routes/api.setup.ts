import { createFileRoute } from "@tanstack/react-router"
import * as Schema from "effect/Schema"
import { createAuth, matchesSecret, sameOrigin } from "../auth/server"
import { getEnv } from "../env"

const Setup = Schema.Struct({
  password: Schema.String.check(
    Schema.isMinLength(12),
    Schema.isMaxLength(128)
  ),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
})
export const Route = createFileRoute("/api/setup")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const env = getEnv()
        if (
          !sameOrigin(request, env.APP_URL) ||
          !(await matchesSecret(
            request.headers.get("x-setup-token") ?? "",
            env.SETUP_TOKEN
          ))
        )
          return Response.json(
            { error: "Setup is not authorized." },
            { status: 403 }
          )
        if (await env.DB.prepare('SELECT id FROM "user" LIMIT 1').first())
          return Response.json(
            { error: "Owner already registered." },
            { status: 409 }
          )
        try {
          const body = Schema.decodeUnknownSync(Setup)(await request.json())
          await createAuth(env, true).api.signUpEmail({
            body: { ...body, email: env.OWNER_EMAIL },
          })
          return Response.json({ ok: true })
        } catch {
          return Response.json(
            {
              error:
                "Could not create the owner. Check your password and try again.",
            },
            { status: 400 }
          )
        }
      },
    },
  },
})
