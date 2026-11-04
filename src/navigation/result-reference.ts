import { Schema } from "effect"

/** Only recorded identities travel in a URL. Result data and private view values
 * stay inside the signed-in assistant's mounted workspace. */
const identity = Schema.Struct({
  turn: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/i)),
  tool: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
  element: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
})
export type ResultIdentity = typeof identity.Type

export function resultReference(value: ResultIdentity) {
  const checked = Schema.decodeUnknownSync(identity)(value)
  const bytes = new TextEncoder().encode(JSON.stringify(checked))
  return `r_${btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")}`
}

export function parseResultReference(value: string): ResultIdentity {
  if (!/^r_[A-Za-z0-9_-]{1,800}$/.test(value))
    throw new Error("Invalid saved result reference.")
  const bytes = Uint8Array.from(
    atob(value.slice(2).replaceAll("-", "+").replaceAll("_", "/")),
    (character) => character.charCodeAt(0)
  )
  const parsed = Schema.decodeUnknownSync(Schema.fromJsonString(identity))(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  )
  if (resultReference(parsed) !== value)
    throw new Error("Invalid saved result reference.")
  return parsed
}

export function isResultReference(value: unknown): value is string {
  if (typeof value !== "string") return false
  try {
    parseResultReference(value)
    return true
  } catch {
    return false
  }
}

export type ResultTabId = `result:${string}`
export function resultTab(reference: string): ResultTabId {
  parseResultReference(reference)
  return `result:${reference}`
}
export function isResultTab(value: unknown): value is ResultTabId {
  return (
    typeof value === "string" &&
    value.startsWith("result:") &&
    isResultReference(value.slice(7))
  )
}
