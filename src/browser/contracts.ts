import { Schema } from "effect"

export class BrowserFailure extends Schema.TaggedError<BrowserFailure>()(
  "BrowserFailure",
  {
    message: Schema.String,
    outcome: Schema.optionalKey(
      Schema.Literals(["rejected", "failed", "uncertain"])
    ),
  }
) {}
export const BROWSER_VIEWPORT = { width: 1024, height: 768 } as const
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
  unrestricted: Schema.optional(Schema.Boolean),
})
export type BrowserPolicy = typeof BrowserPolicy.Type
export const BrowserPage = Schema.Struct({
  focus: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        label: Schema.String.check(Schema.isMaxLength(120)),
        kind: Schema.String.check(Schema.isMaxLength(40)),
        secret: Schema.Boolean,
      })
    )
  ),
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
  controller: Schema.Literals(["agent", "owner"]),
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
export function allowedBrowserUrl(
  value: string,
  hosts: readonly string[],
  unrestricted = false
) {
  try {
    const url = new URL(value)
    Schema.decodeUnknownSync(Hostname)(url.hostname)
    if (
      (unrestricted
        ? !["http:", "https:"].includes(url.protocol)
        : url.protocol !== "https:") ||
      url.username ||
      url.password ||
      (!unrestricted && (url.port || !hosts.includes(url.hostname)))
    )
      throw new Error("Destination")
    return url.href
  } catch {
    throw new BrowserFailure({
      message: unrestricted
        ? "Choose an HTTP or HTTPS URL with a public hostname and no embedded credentials."
        : "Choose an HTTPS URL on this bot's allowed sites, without credentials or a custom port.",
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
  controller: "agent" | "owner"
  generation: number
  hosts: readonly string[]
  unrestricted: boolean
  version: number
  status: BrowserState["status"]
  session: BrowserSession | null
  capture: BrowserCapture | null
  error: string | null
}
export function browserState(record: BrowserRecord, now: number): BrowserState {
  return {
    controller: record.controller,
    policy: {
      generation: record.generation,
      hosts: record.hosts,
      unrestricted: record.unrestricted,
    },
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

export const BrowserController = Schema.Literals(["agent", "owner"])
export type BrowserController = typeof BrowserController.Type
export const BrowserControl = Schema.Struct({
  generation: BrowserPolicy.fields.generation,
  controller: BrowserController,
})
const integer = (maximum: number, minimum = 0) =>
  Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(minimum),
    Schema.isLessThanOrEqualTo(maximum)
  )
export const BrowserKey = Schema.Literals([
  "Enter",
  "Tab",
  "Backspace",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Delete",
  "SelectAll",
])
export const BrowserAction = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("click"),
    x: integer(1023),
    y: integer(767),
  }),
  Schema.Struct({
    kind: Schema.Literal("type"),
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
  }),
  Schema.Struct({ kind: Schema.Literal("key"), key: BrowserKey }),
  Schema.Struct({ kind: Schema.Literal("scroll"), deltaY: integer(768, -768) }),
])
export type BrowserAction = typeof BrowserAction.Type
export const BrowserInteraction = Schema.Struct({
  generation: BrowserPolicy.fields.generation,
  version: BrowserPolicy.fields.generation,
  action: BrowserAction,
})
export type BrowserInteraction = typeof BrowserInteraction.Type
export type BrowserObservation = BrowserCapture & {
  generation: number
  version: number
}
