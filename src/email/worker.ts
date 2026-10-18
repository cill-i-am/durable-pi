import { Effect } from "effect"

import type { EmailEnv } from "../../alchemy.run"
import { ownerAccounts } from "../auth/adapters/accounts"
import { receiveCloudflareEmail } from "./adapters/incoming"
import { EmailRejected } from "./contracts"

// Invocation logging is disabled on this ingress Worker: recipient addresses
// contain private capabilities. Agent work runs over the private service binding.
export default {
  fetch: () => new Response("Not found", { status: 404 }),
  async email(message: ForwardableEmailMessage, env: EmailEnv) {
    await receiveCloudflareEmail(message, {
      ownerEmail: env.OWNER_EMAIL,
      domain: env.AGENT_EMAIL_DOMAIN,
      deliver: async (id, input, attachments) => {
        const owner = await Effect.runPromise(
          ownerAccounts(env.AUTH_DB).owner(env.OWNER_EMAIL)
        )
        if (!owner)
          throw new EmailRejected({
            message: "Set up the owner account before using email.",
          })
        const body = new FormData()
        body.set("message", JSON.stringify(input))
        for (const file of attachments)
          body.append(
            "attachment",
            new Blob([new Uint8Array(file.bytes)], { type: file.mime }),
            file.name
          )
        const response = await env.AGENT_SERVICE.fetch(
          new Request(
            `https://agent.internal/api/agent/email/incoming?agent=${id}`,
            {
              method: "POST",
              headers: {
                "x-owner-id": owner,
              },
              body,
            }
          )
        )
        // Consume the internal response; do not expose its private details or
        // turn transient failures into a permanent SMTP rejection.
        await response.body?.cancel()
        if ([400, 401, 403, 404, 409, 413].includes(response.status))
          throw new EmailRejected({
            message:
              "This agent email address is unavailable, revoked, or its inbox is full. Check Email in the agent's settings.",
          })
        if (response.status !== 202)
          throw new Error("Agent email admission is temporarily unavailable.")
      },
    })
  },
} satisfies ExportedHandler<EmailEnv>
