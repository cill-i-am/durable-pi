import { Schema } from "effect"
import { WebhookKey } from "../contracts"

export async function digest(value: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
    )
  )
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}
export function bearer(request: Request) {
  const value =
    request.headers.get("authorization")?.replace(/^Bearer /, "") ?? ""
  return Schema.is(WebhookKey)(value) ? value : null
}
