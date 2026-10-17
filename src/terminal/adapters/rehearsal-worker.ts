import { timingSafeEqual } from "node:crypto"

import type { SandboxRehearsalEnv } from "../../../stacks/sandbox-hosted-rehearsal"

export default {
  async fetch(request: Request, env: SandboxRehearsalEnv) {
    const bearer =
      request.headers.get("authorization")?.replace(/^Bearer /, "") ?? ""
    const encoder = new TextEncoder()
    const [actual, expected] = await Promise.all([
      crypto.subtle.digest("SHA-256", encoder.encode(bearer)),
      crypto.subtle.digest("SHA-256", encoder.encode(env.TOKEN)),
    ])
    if (
      !env.TOKEN ||
      !timingSafeEqual(new Uint8Array(actual), new Uint8Array(expected))
    )
      return new Response("Unauthorized", { status: 401 })
    const url = new URL(request.url)
    const [, kind, ...parts] = url.pathname.split("/")
    const target =
      kind === "legacy" ? env.LEGACY : kind === "native" ? env.NATIVE : null
    if (target) {
      const headers = new Headers(request.headers)
      headers.delete("authorization")
      return target.fetch(
        new Request(
          "https://terminal.internal/" + parts.join("/") + url.search,
          {
            method: request.method,
            headers,
            body: request.body,
            redirect: "manual",
          }
        )
      )
    }
    return new Response("Not found", { status: 404 })
  },
}
