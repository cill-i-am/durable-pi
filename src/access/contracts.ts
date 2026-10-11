import { Schema } from "effect"

export const AccessMode = Schema.Literals(["allow", "ask", "deny"])
export type AccessMode = typeof AccessMode.Type
export const ToolPolicy = Schema.Struct({
  name: Schema.String,
  title: Schema.optional(Schema.String),
  description: Schema.String,
  mode: AccessMode,
  revision: Schema.Number,
})
export type ToolPolicy = typeof ToolPolicy.Type
export const Approval = Schema.Struct({
  id: Schema.String,
  turnId: Schema.String,
  tool: Schema.String,
  input: Schema.String,
  createdAt: Schema.Number,
  expiresAt: Schema.Number,
  status: Schema.Literals([
    "pending",
    "approved",
    "running",
    "done",
    "denied",
    "cancelled",
    "expired",
    "interrupted",
  ]),
  revision: Schema.Number,
})
export type Approval = typeof Approval.Type
export const AccessState = Schema.Struct({
  tools: Schema.Array(ToolPolicy),
  approvals: Schema.Array(Approval),
})
export type AccessState = typeof AccessState.Type
export const UpdatePolicy = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(120)),
  expectedRevision: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0)
  ),
  mode: AccessMode,
})
export const DecideApproval = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(200)),
  approve: Schema.Boolean,
  expectedRevision: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0)
  ),
})
export class AccessDenied extends Schema.TaggedError<AccessDenied>()(
  "AccessDenied",
  { message: Schema.String }
) {}
export class AccessConflict extends Schema.TaggedError<AccessConflict>()(
  "AccessConflict",
  { message: Schema.String }
) {}

export const builtInTools = [
  {
    name: "run_code",
    title: "Run isolated code",
    description:
      "Execute JavaScript with explicit JSON input, no network or app credentials, and bounded runtime/output.",
    mode: "ask",
  },
  {
    name: "browser_open",
    title: "Open browser page",
    description:
      "Navigate this bot's Cloudflare browser within its allowed sites.",
    mode: "ask",
  },
  {
    name: "browser_read",
    title: "Read browser page",
    description: "Read this bot's current browser page and screenshot.",
    mode: "ask",
  },
  {
    name: "browser_interact",
    title: "Interact with browser",
    description:
      "Click, type, scroll or press keys on a browser page. Can change external sites.",
    mode: "ask",
  },
  {
    name: "list_files",
    description: "List this bot's private files.",
    mode: "allow",
  },
  {
    name: "read_file",
    description: "Read this bot's text and extracted documents.",
    mode: "allow",
  },
  {
    name: "zoom",
    description: "Read this bot's archived messages and summaries.",
    mode: "allow",
  },
  { name: "date", description: "Read a message timestamp.", mode: "allow" },
  {
    name: "search_memory",
    description: "Search this bot's conversation archive.",
    mode: "allow",
  },
  {
    name: "read_note",
    description: "Read this bot's memory notes.",
    mode: "allow",
  },
  {
    name: "write_note",
    description: "Save or replace a private memory note.",
    mode: "allow",
  },
] as const satisfies readonly Omit<ToolPolicy, "revision">[]
