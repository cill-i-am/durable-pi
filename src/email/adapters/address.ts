import { timingSafeEqual } from "node:crypto"

import { Schema } from "effect"

import { AgentId } from "../../agents/domain"

// The address is an owner-scoped capability. An email From header is never
// treated as sufficient authentication. Lowercase base32 survives mail systems
// that normalize the local part, and keeps UUID addresses below 64 characters.
function base32(bytes: Uint8Array) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567"
  let value = 0,
    bits = 0,
    output = ""
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      output += alphabet[(value >>> bits) & 31]
    }
  }
  if (bits) output += alphabet[(value << (5 - bits)) & 31]
  return output
}
export async function emailAddress(
  secret: string,
  domain: string,
  owner: string,
  agent: AgentId,
  generation: number
) {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(
      JSON.stringify(["agent-email:v1", domain, owner, agent, generation])
    )
  )
  return `${agent.replaceAll("-", "")}+${base32(new Uint8Array(signature).slice(0, 16))}@${domain}`
}
export function emailAgent(
  address: string,
  domain: string
): AgentId | undefined {
  const match = /^(home|[a-f0-9]{32})\+[a-z2-7]{26}@([^@]+)$/.exec(address)
  if (!match || match[2] !== domain) return
  const compact = match[1]!
  const id =
    compact === "home"
      ? compact
      : compact.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5")
  const parsed = Schema.decodeUnknownOption(AgentId)(id)
  return parsed._tag === "Some" ? parsed.value : undefined
}
export function sameAddress(supplied: string, expected: string) {
  const left = new TextEncoder().encode(supplied)
  const right = new TextEncoder().encode(expected)
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}
export const emailConfigured = (domain: string, secret: string) =>
  /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(domain) &&
  secret.length >= 32
