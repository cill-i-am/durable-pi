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
  remember: Schema.optional(
    Schema.Struct({
      expectedPolicyRevision: Schema.Number.check(
        Schema.isInt(),
        Schema.isGreaterThanOrEqualTo(0)
      ),
    })
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
export class AccessStorageError extends Schema.TaggedError<AccessStorageError>()(
  "AccessStorageError",
  { operation: Schema.String, cause: Schema.Unknown }
) {}

export const builtInTools = [
  {
    name: "show_brief",
    title: "Compose an answer brief",
    description:
      "Present related sourced cards as a day brief or multi-part answer.",
    mode: "allow",
  },
  {
    name: "ask_question",
    title: "Ask a clarification question",
    description:
      "Present choices and a free-text answer for the user to review in their draft.",
    mode: "allow",
  },
  {
    name: "compare_products",
    title: "Compare product offers",
    description:
      "Present sourced products, shortlists and a comparison workspace. No purchases.",
    mode: "allow",
  },
  {
    name: "analyze_data",
    title: "Analyze supplied data",
    description:
      "Group numeric data locally and present tables, summaries and charts.",
    mode: "allow",
  },
  {
    name: "lookup_route",
    title: "Look up a driving route",
    description:
      "Send sourced stop coordinates to OSRM and show a driving route estimate.",
    mode: "allow",
  },
  {
    name: "search_products",
    title: "Search for products",
    description:
      "Search Google Shopping in the bot's browser using its saved internet settings. No purchases.",
    mode: "allow",
  },
  {
    name: "show_ui",
    title: "Show an interactive answer",
    description:
      "Present sourced cards, product comparisons, tables, charts and timelines in chat. No external actions.",
    mode: "allow",
  },
  {
    name: "calculate",
    title: "Calculate",
    description: "Evaluate arithmetic locally and show the result.",
    mode: "allow",
  },
  {
    name: "convert_units",
    title: "Convert measurements",
    description: "Convert compatible units locally.",
    mode: "allow",
  },
  {
    name: "lookup_places",
    title: "Look up places",
    description:
      "Send an address or place query to Photon/OpenStreetMap and show map candidates.",
    mode: "allow",
  },
  {
    name: "lookup_weather",
    title: "Look up weather",
    description:
      "Send coordinates to Open-Meteo and show a seven-day forecast.",
    mode: "allow",
  },
  {
    name: "discover_bots",
    title: "Discover bots",
    description: "List other active bots owned by this account.",
    mode: "allow",
  },
  {
    name: "delegate_bot",
    title: "Contact another bot",
    description:
      "Send a bounded text-only question or drafting task to another owned bot. No file, object or action grants.",
    mode: "ask",
  },
  {
    name: "check_bot_task",
    title: "Read bot task",
    description: "Inspect this bot's durable task result.",
    mode: "allow",
  },
  {
    name: "background_tasks",
    title: "Background drafting",
    description:
      "Start bounded drafting tasks using supplied text only; no child tools or outside actions. Findings arrive later in this bot.",
    mode: "ask",
  },
  {
    name: "delegate_tasks",
    title: "Delegate research tasks",
    description:
      "Run up to three request-owned research or drafting children with selected read tools and bounded subscription usage.",
    mode: "ask",
  },
  {
    name: "update_plan",
    title: "Maintain task plan",
    description:
      "Save this task's objective, steps and evidence. Grants no action permissions.",
    mode: "allow",
  },
  {
    name: "read_plan",
    title: "Read task plan",
    description: "Inspect this bot's saved task plans and revisions.",
    mode: "allow",
  },
  {
    name: "list_objects",
    title: "List working objects",
    description: "List this bot's private persistent checklists.",
    mode: "allow",
  },
  {
    name: "read_object",
    title: "Read working object",
    description: "Read current checklist state and recent change references.",
    mode: "allow",
  },
  {
    name: "create_checklist",
    title: "Create checklist",
    description:
      "Create a private checklist that you and this bot can maintain.",
    mode: "allow",
  },
  {
    name: "update_checklist",
    title: "Edit checklist",
    description:
      "Update, archive or restore this bot's checklist with revision checks.",
    mode: "allow",
  },
  {
    name: "run_command",
    title: "Run Linux command",
    description:
      "Execute shell commands in a private container with a saved workspace, owner-controlled internet access, and bounded runtime/output.",
    mode: "ask",
  },
  {
    name: "list_routines",
    title: "List routines",
    description: "Read this bot's scheduled work.",
    mode: "allow",
  },
  {
    name: "read_family",
    title: "Read family access",
    description:
      "Read family membership and model provider without opening anyone's private work.",
    mode: "allow",
  },
  {
    name: "manage_family",
    title: "Manage family access",
    description:
      "Admin only: invite, resend, cancel invitations or remove a member. Sends invitation email and changes access.",
    mode: "ask",
  },
  {
    name: "get_model_settings",
    title: "Read model settings",
    description:
      "Read this agent's model defaults and shared ChatGPT availability.",
    mode: "allow",
  },
  {
    name: "set_model_settings",
    title: "Change model defaults",
    description:
      "Change this private agent's model defaults. Running jobs keep their model.",
    mode: "ask",
  },
  {
    name: "read_routine",
    title: "Read routine",
    description: "Read a routine and its instructions.",
    mode: "allow",
  },
  {
    name: "save_routine",
    title: "Schedule routine",
    description:
      "Create or edit work that runs with the browser closed, under existing tool permissions.",
    mode: "ask",
  },
  {
    name: "set_routine_status",
    title: "Change routine status",
    description: "Pause, resume or archive scheduled work.",
    mode: "ask",
  },
  {
    name: "list_apps",
    title: "List private apps",
    description: "List this bot's generated apps.",
    mode: "allow",
  },
  {
    name: "read_app",
    title: "Read private app",
    description: "Read an app definition, saved state and interactions.",
    mode: "allow",
  },
  {
    name: "save_app",
    title: "Save app draft",
    description: "Create a versioned private app using bounded UI components.",
    mode: "allow",
  },
  {
    name: "publish_app",
    title: "Publish private app",
    description:
      "Make a saved app version interactive for the owner; it remains private.",
    mode: "ask",
  },
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
      "Navigate this bot's Cloudflare browser using its saved internet settings.",
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
    name: "share_image",
    title: "Include image in reply",
    description:
      "Include an image from this agent's private files in its reply across connected surfaces.",
    mode: "allow",
  },
  {
    name: "view_image",
    title: "Inspect image",
    description:
      "Inspect a bounded preview of an image in this agent's private files.",
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
