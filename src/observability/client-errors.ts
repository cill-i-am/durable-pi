import { Schema } from "effect"

const names = [
  "Error",
  "TypeError",
  "ReferenceError",
  "RangeError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "AbortError",
  "TimeoutError",
  "NetworkError",
  "ChunkLoadError",
  "SchemaError",
  "Other",
] as const
const messages = [
  "Resource identity belongs in the page path.",
  "Connection results belong to Settings.",
  "Settings presentation belongs to Settings.",
  "Activity filters belong to Activity.",
  "A file preview requires a selected file.",
  "Archive search belongs to Memory.",
  "This tab does not belong to the selected workspace panel.",
  "This panel does not select a saved resource.",
  "An activity agent requires the Activity panel.",
  "Family access must be loaded before opening the workspace.",
  "Failed to load a JavaScript module",
  "Cannot read properties of undefined",
  "Cannot read properties of null",
  "Value is not a function",
  "Reference is not defined",
  "Maximum call stack size exceeded",
  "Network request failed",
  "Invalid JSON",
  "React error",
  "Schema validation failed",
  "Unclassified browser exception",
] as const
const asset = Schema.String.check(
  Schema.isPattern(
    /^\/assets\/[A-Za-z0-9_$.-]+-[A-Za-z0-9_-]{8,16}\.(?:js|css)$/
  ),
  Schema.isMaxLength(200)
)
const position = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(100_000_000)
)
const Frame = Schema.Struct({ file: asset, line: position, column: position })
const Failure = Schema.Struct({
  name: Schema.Literals(names),
  message: Schema.Literals(messages),
  reactCode: Schema.optional(position),
  module: Schema.optional(asset),
  frames: Schema.Array(Frame).check(Schema.isMaxLength(12)),
})
export const ClientErrorReport = Schema.Struct({
  id: Schema.String.check(
    Schema.isPattern(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/)
  ),
  build: Schema.String.check(
    Schema.isPattern(/^(?:[a-f0-9]{40}|development)$/)
  ),
  surface: Schema.Literals([
    "workspace",
    "window-error",
    "unhandled-rejection",
    "activity-orb",
    "activity-border",
  ]),
  page: Schema.Literals([
    "chat",
    "settings",
    "workbench",
    "agents",
    "editor",
    "other",
  ]),
  online: Schema.Boolean,
  failure: Failure,
  causes: Schema.Array(Failure).check(Schema.isMaxLength(3)),
  components: Schema.Array(Frame).check(Schema.isMaxLength(20)),
})
export type ClientErrorReport = typeof ClientErrorReport.Type
type Failure = typeof Failure.Type

function assetPath(value: string, origin: string) {
  try {
    const url = new URL(value)
    return url.origin === origin && Schema.is(asset)(url.pathname)
      ? url.pathname
      : undefined
  } catch {
    return undefined
  }
}
function frames(stack: string, origin: string, limit: number) {
  return stack
    .slice(0, 16_000)
    .split("\n")
    .flatMap((line) => {
      const match = line.match(/(https?:\/\/[^\s()]+):(\d+):(\d+)\)?$/)
      const file = match && assetPath(match[1]!, origin)
      return file
        ? [{ file, line: Number(match![2]), column: Number(match![3]) }]
        : []
    })
    .slice(0, limit)
}
function safeMessage(message: string): Failure["message"] {
  const exact = messages.find((item) => item === message)
  if (exact) return exact
  if (
    /^(?:Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module)/i.test(
      message
    )
  )
    return "Failed to load a JavaScript module"
  if (/^Cannot read properties of undefined/.test(message))
    return "Cannot read properties of undefined"
  if (/^Cannot read properties of null/.test(message))
    return "Cannot read properties of null"
  if (/ is not a function\b/.test(message)) return "Value is not a function"
  if (/ is not defined\b/.test(message)) return "Reference is not defined"
  if (/^Maximum call stack size exceeded|^too much recursion/i.test(message))
    return "Maximum call stack size exceeded"
  if (
    /^(?:Failed to fetch|Load failed|NetworkError when attempting)/.test(
      message
    )
  )
    return "Network request failed"
  if (/^Unexpected (?:token|end of JSON)|^JSON.parse:/.test(message))
    return "Invalid JSON"
  if (/^Minified React error #\d+/.test(message)) return "React error"
  return "Unclassified browser exception"
}
function failure(value: unknown, origin: string): Failure {
  const object = value !== null && typeof value === "object" ? value : {}
  const rawName =
    "name" in object && typeof object.name === "string" ? object.name : "Other"
  const message =
    "message" in object && typeof object.message === "string"
      ? object.message.slice(0, 4096)
      : ""
  const stack =
    "stack" in object && typeof object.stack === "string" ? object.stack : ""
  const moduleUrl = message.match(/https?:\/\/[^\s]+/)?.[0]
  const module = moduleUrl && assetPath(moduleUrl, origin)
  const reactCode = /^Minified React error #(\d+)/.exec(message)?.[1]
  return {
    name: names.find((item) => item === rawName) ?? "Other",
    message:
      rawName === "SchemaError"
        ? "Schema validation failed"
        : safeMessage(message),
    ...(module ? { module } : {}),
    ...(reactCode ? { reactCode: Number(reactCode) } : {}),
    frames: frames(stack, origin, 12),
  }
}
/** Only fixed diagnostic messages and same-origin build assets can leave the browser. */
export function clientFailure(
  error: unknown,
  origin: string,
  componentStack = ""
) {
  const causes: Failure[] = []
  const seen = new Set<unknown>([error])
  let next = error
  while (
    next !== null &&
    typeof next === "object" &&
    "cause" in next &&
    causes.length < 3
  ) {
    next = next.cause
    if (next === undefined || seen.has(next)) break
    seen.add(next)
    causes.push(failure(next, origin))
  }
  return {
    failure: failure(error, origin),
    causes,
    components: frames(componentStack, origin, 20),
  }
}
export function errorPage(path: string): ClientErrorReport["page"] {
  if (/^\/agents\/(?:new|[^/]+\/edit)\/?$/.test(path)) return "editor"
  if (/^\/agents(?:\/archived)?\/?$/.test(path)) return "agents"
  if (/^\/agents\/[^/]+\/settings\//.test(path)) return "settings"
  if (/^\/agents\/[^/]+\/[^/]+/.test(path)) return "workbench"
  return /^\/agents\/[^/]+\/?$/.test(path) ? "chat" : "other"
}
