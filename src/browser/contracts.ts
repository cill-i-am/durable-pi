import { Schema } from "effect"

export class BrowserFailure extends Schema.TaggedError<BrowserFailure>()(
  "BrowserFailure",
  { message: Schema.String }
) {}
export const Hostname = Schema.String.check(
  Schema.makeFilter((value) => {
    if (
      value !== value.toLowerCase() ||
      value.length > 253 ||
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(value)
    )
      return "Use an exact public hostname."
    if (
      /(^|\.)(localhost|local|internal|test|invalid|example)$/.test(value) ||
      value
        .split(".")
        .some(
          (label) =>
            !label ||
            label.length > 63 ||
            label.startsWith("-") ||
            label.endsWith("-")
        )
    )
      return "Use an exact public hostname."
    return true
  })
)
export const BrowserPolicy = Schema.Struct({
  generation: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0)
  ),
  hosts: Schema.Array(Hostname).check(Schema.isMaxLength(20)),
})
export type BrowserPolicy = typeof BrowserPolicy.Type
export const BrowserPage = Schema.Struct({
  url: Schema.String.check(Schema.isMaxLength(2048)),
  title: Schema.String.check(Schema.isMaxLength(200)),
  text: Schema.String.check(Schema.isMaxLength(24_000)),
  links: Schema.Array(
    Schema.Struct({
      text: Schema.String.check(Schema.isMaxLength(120)),
      url: Schema.String.check(Schema.isMaxLength(2048)),
    })
  ).check(Schema.isMaxLength(20)),
  capturedAt: Schema.Number,
})
export type BrowserPage = typeof BrowserPage.Type
export const BrowserState = Schema.Struct({
  policy: BrowserPolicy,
  version: Schema.Number,
  status: Schema.Literals(["closed", "loading", "ready", "expired", "error"]),
  expiresAt: Schema.NullOr(Schema.Number),
  page: Schema.NullOr(BrowserPage),
  hasScreenshot: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
})
export type BrowserState = typeof BrowserState.Type
export const BrowserNavigate = Schema.Struct({
  url: Schema.String.check(Schema.isMaxLength(2048)),
  generation: BrowserPolicy.fields.generation,
})
export const BrowserGeneration = Schema.Struct({
  generation: BrowserPolicy.fields.generation,
})
export function allowedBrowserUrl(value: string, hosts: readonly string[]) {
  try {
    const url = new URL(value)
    Schema.decodeUnknownSync(Hostname)(url.hostname)
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !hosts.includes(url.hostname)
    )
      throw new Error("Destination")
    return url.href
  } catch {
    throw new BrowserFailure({
      message:
        "Choose an HTTPS URL on this bot's allowed sites, without credentials or a custom port.",
    })
  }
}
export const BROWSER_SESSION_MS = 10 * 60_000
export const BROWSER_IDLE_MS = 2 * 60_000
export interface BrowserSession {
  id: string
  targetId: string
  expiresAt: number
  idleExpiresAt?: number
}
export function browserDeadline(session: BrowserSession) {
  return Math.min(session.expiresAt, session.idleExpiresAt ?? session.expiresAt)
}
export interface BrowserCapture {
  page: BrowserPage
  screenshot: string | null
}
export interface BrowserRecord {
  generation: number
  hosts: readonly string[]
  version: number
  status: BrowserState["status"]
  session: BrowserSession | null
  capture: BrowserCapture | null
  error: string | null
}
export function browserState(
  record: BrowserRecord,
  now = Date.now()
): BrowserState {
  return {
    policy: { generation: record.generation, hosts: record.hosts },
    version: record.version,
    status:
      record.session && browserDeadline(record.session) <= now
        ? "expired"
        : record.status,
    expiresAt: record.session ? browserDeadline(record.session) : null,
    page: record.capture?.page ?? null,
    hasScreenshot: !!record.capture?.screenshot,
    error: record.error,
  }
}
