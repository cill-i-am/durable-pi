import { DurableObject } from "cloudflare:workers"
import {
  Lifecycle,
  LifecycleCapability,
  type LifecycleJobOutcome,
} from "agents/lifecycle"
import { PiHarness } from "agents/harness/pi"
import {
  createRegistry,
  defineTool,
  Harness,
  type EntryRecord,
} from "@earendil-works/pi-durable"
import { Type } from "@earendil-works/pi-ai"
import * as Schema from "effect/Schema"
import * as Effect from "effect/Effect"
import type { AgentEnv } from "../../alchemy.run"
import { MemoryStore, type Sqlite } from "./memory"
import { createAgentModels, DurableCredentials } from "./models"
import { SYSTEM_PROMPT } from "./prompts"
import { importHistory, ImportInput } from "./import"
import { pumpSummaries } from "./compactor"
import { backupMemory } from "./backup"
import { exportResponse, watermark } from "./archive"
import type { CacheUsage } from "./cache"
import {
  CancelInput,
  SendInput,
  type ChatState,
  type ChatTurn,
} from "../shared/contracts"

const toolText = (text: string) => ({
  content: [{ type: "text" as const, text }],
})
const textContent = (content: readonly { type: string; text?: string }[]) =>
  content
    .filter((x) => x.type === "text")
    .map((x) => x.text ?? "")
    .join("\n")

class TurnRunner extends LifecycleCapability {
  constructor(
    readonly owner: PersonalAgent,
    readonly capability = "personal-chat"
  ) {
    super(capability)
  }
  async wake() {
    await this.lifecycle.jobs.push({
      // Lifecycle job IDs share a queue across capabilities. Keep the original
      // chat ID for upgrades; compaction and backup own distinct IDs.
      id:
        this.capability === "personal-chat"
          ? "pump"
          : `${this.capability}:pump`,
      fn: "pump",
      time: Date.now(),
      singleflight: true,
      hungTimeoutSeconds: 600,
      recoveryLoop: true,
    })
  }
  async onJob(): Promise<LifecycleJobOutcome> {
    // Lifecycle owns retries and alarms. A crash re-enters from durable turn state.
    return this.owner.step()
  }
}

class MemoryRunner extends TurnRunner {
  constructor(owner: PersonalAgent) {
    super(owner, "memory-compactor")
  }
  async onJob(): Promise<LifecycleJobOutcome> {
    const before = JSON.stringify(watermark(this.owner.memory))
    const model = this.owner.models.getModel(
      "openai",
      this.owner.summaryModelId
    )
    if (!model) throw new Error("Unknown summary model")
    const next = await pumpSummaries(
      this.owner.memory,
      (request) =>
        this.owner.models.completeSimple(model, request, {
          reasoning: "medium",
          signal: AbortSignal.timeout(60_000),
          cacheRetention: "short",
        }),
      {
        report: (range) =>
          console.warn(
            `Memory summary ${range} failed; retrying in 10 seconds`
          ),
      }
    )
    if (before !== JSON.stringify(watermark(this.owner.memory)))
      await this.owner.backups.wake()
    if (this.owner.active()) await this.owner.runner.wake()
    return next === undefined ? undefined : { rescheduleAt: next }
  }
}
class BackupRunner extends TurnRunner {
  constructor(owner: PersonalAgent) {
    super(owner, "memory-backups")
  }
  async onJob(): Promise<LifecycleJobOutcome> {
    const owner = this.owner
    const before = JSON.stringify(watermark(owner.memory))
    if (
      owner.db.all<{ watermark: string }>(
        "SELECT watermark FROM memory_backup_status WHERE id=1"
      )[0]?.watermark === before
    )
      return
    try {
      const result = await backupMemory(
        owner.memory,
        owner.backupBucket,
        owner.backupPrefix()
      )
      owner.db.run(
        "INSERT INTO memory_backup_status VALUES (1,?,?,?) ON CONFLICT(id) DO UPDATE SET date=coalesce(excluded.date,memory_backup_status.date),watermark=excluded.watermark,error=excluded.error",
        result.pending ? null : result.date,
        result.pending ? "" : before,
        result.pending ? "Backup in progress" : null
      )
      return result.pending ||
        before !== JSON.stringify(watermark(owner.memory))
        ? { rescheduleAt: Date.now() + 100 }
        : undefined
    } catch {
      owner.db.run(
        "INSERT INTO memory_backup_status VALUES (1,NULL,'',?) ON CONFLICT(id) DO UPDATE SET error=excluded.error",
        "Backup pending; retrying"
      )
      return { rescheduleAt: Date.now() + 10_000 }
    }
  }
}

export class PersonalAgent extends DurableObject<AgentEnv> {
  get summaryModelId() {
    return this.env.SUMMARY_MODEL_ID
  }
  get backupBucket() {
    return this.env.MEMORY_BACKUPS
  }
  readonly db: Sqlite = {
    all: <T>(query: string, ...bindings: (string | number | null)[]) =>
      this.ctx.storage.sql.exec(query, ...bindings).toArray() as T[],
    run: (query, ...bindings) => {
      this.ctx.storage.sql.exec(query, ...bindings)
    },
    transaction: (body) => this.ctx.storage.transactionSync(body),
  }
  readonly memory = new MemoryStore(this.db)
  readonly credentials = new DurableCredentials(
    this.db,
    this.env.OPENAI_CREDENTIAL
  )
  readonly models = createAgentModels(this.credentials, {
    cacheKey: `pi-${this.ctx.id.toString()}`,
    onUsage: (usage: CacheUsage) =>
      this.db.run(
        "INSERT OR IGNORE INTO model_usage VALUES (?,?,?,?,?,?)",
        usage.id,
        usage.model,
        usage.input,
        usage.cached,
        usage.output,
        new Date().toISOString()
      ),
  })
  readonly registry = createRegistry()
  readonly harness = new PiHarness({
    harness: ({ storage, context }) => {
      this.registry.install({
        name: "personal",
        sections: [
          { key: "preamble", render: () => SYSTEM_PROMPT, tag: false },
        ],
        tools: [
          defineTool({
            name: "zoom",
            description:
              "Open line id+n into its two child summaries; n=1 gives the original message whole.",
            parameters: Type.Object({
              id: Type.Integer({ minimum: 0 }),
              n: Type.Integer({ minimum: 1 }),
            }),
            replay: "safe",
            execute: async (args) =>
              toolText(this.memory.zoom(args.id, args.n)),
          }),
          defineTool({
            name: "date",
            description: "Get the original date and time of a message.",
            parameters: Type.Object({ id: Type.Integer({ minimum: 0 }) }),
            replay: "safe",
            execute: async (args) =>
              toolText(this.memory.entry(args.id)?.date ?? "Message not found"),
          }),
          defineTool({
            name: "search_memory",
            description:
              "Find exact archived messages by text, then zoom to read them. Returns at most 30 results.",
            parameters: Type.Object({
              query: Type.String({ minLength: 1, maxLength: 200 }),
            }),
            replay: "safe",
            execute: async (args) =>
              toolText(
                JSON.stringify(
                  this.memory
                    .search(args.query)
                    .map(({ id, kind, text, date }) => ({
                      id,
                      kind,
                      date,
                      preview: text.slice(0, 300),
                    }))
                )
              ),
          }),
          defineTool({
            name: "read_note",
            description:
              "Read a private Markdown memory note. Use path MEMORY.md for the index; an empty path lists available notes.",
            parameters: Type.Object({ path: Type.String() }),
            replay: "safe",
            execute: async (args) =>
              toolText(
                args.path
                  ? (this.memory.notes().find((n) => n.path === args.path)
                      ?.body ?? "Note not found")
                  : this.memory
                      .notes()
                      .map((n) => n.path)
                      .join("\n")
              ),
          }),
          defineTool({
            name: "write_note",
            description:
              "Save a stable fact or correction as a private Markdown note, citing the source message ID. Use [[path]] links. Never save passwords, tokens, or secrets.",
            parameters: Type.Object({
              path: Type.String(),
              body: Type.String({ maxLength: 16000 }),
              sourceId: Type.Integer({ minimum: 0 }),
            }),
            replay: "safe",
            execute: async (args) => {
              this.memory.writeNote(args.path, args.body, args.sourceId)
              return toolText("Saved private memory note")
            },
          }),
        ],
      })
      return Harness.open(
        storage,
        {
          models: this.models,
          registry: this.registry,
          settings: {
            compaction: { enabled: false },
            retry: { enabled: true, maxRetries: 3, baseDelayMs: 1000 },
          },
          onReport: () => console.warn("Pi reported an operation failure"),
        },
        context
      )
    },
    defaults: {
      model: { provider: "openai", id: this.env.MODEL_ID },
      thinkingLevel: "medium",
    },
  })
  readonly runner = new TurnRunner(this)
  readonly compactor = new MemoryRunner(this)
  readonly backups = new BackupRunner(this)
  readonly lifecycle = Lifecycle.install(this)
    .use(this.harness)
    .use(this.runner)
    .use(this.compactor)
    .use(this.backups)

  constructor(ctx: DurableObjectState, env: AgentEnv) {
    super(ctx, env)
    this.db.run(
      "CREATE TABLE IF NOT EXISTS model_usage (id TEXT PRIMARY KEY,model TEXT NOT NULL,input INTEGER NOT NULL,cached INTEGER NOT NULL,output INTEGER NOT NULL,date TEXT NOT NULL)"
    )
    this.db.run(
      "CREATE TABLE IF NOT EXISTS memory_backup_status (id INTEGER PRIMARY KEY,date TEXT,watermark TEXT NOT NULL,error TEXT)"
    )
    this.db.run(
      "CREATE TABLE IF NOT EXISTS chat_turns (id TEXT PRIMARY KEY,text TEXT NOT NULL,status TEXT NOT NULL,answer TEXT NOT NULL DEFAULT '',error TEXT,created_at TEXT NOT NULL,session_id TEXT,prompt TEXT)"
    )
  }

  async onStart() {
    if (this.active()) await this.runner.wake()
    if (this.memory.next() || this.memory.retryAt()) await this.compactor.wake()
    if (
      this.memory.total() &&
      this.db.all<{ watermark: string }>(
        "SELECT watermark FROM memory_backup_status WHERE id=1"
      )[0]?.watermark !== JSON.stringify(watermark(this.memory))
    )
      await this.backups.wake()
  }
  backupPrefix() {
    return `memory/${this.ctx.id.toString()}`
  }
  active() {
    return this.db.all<ChatTurn>(
      "SELECT * FROM chat_turns WHERE status IN ('queued','preparing','running') ORDER BY rowid LIMIT 1"
    )[0]
  }
  current(id: string) {
    return this.db.all<ChatTurn>("SELECT * FROM chat_turns WHERE id=?", id)[0]!
  }

  async fetch(request: Request): Promise<Response> {
    await this.lifecycle.start()
    const url = new URL(request.url),
      path = url.pathname.replace("/api/agent/", "")
    try {
      if (request.method === "GET" && path === "export")
        return exportResponse(
          this.memory,
          url.searchParams.get("format") === "html"
        )
      if (request.method === "GET" && path === "tree") {
        const parts = this.memory.parts()
        const start = Number(url.searchParams.get("id")),
          count = Number(url.searchParams.get("n"))
        if (url.searchParams.has("id")) {
          const text = this.memory.zoom(start, count)
          return Response.json({
            text,
            children:
              count > 1
                ? [start, start + count / 2].map((id) =>
                    this.memory.node({ start: id, count: count / 2 })
                  )
                : [],
            original: count === 1 ? this.memory.entry(start) : null,
          })
        }
        return Response.json(
          parts.map((part) => ({
            ...part,
            text: this.memory.node(part)?.text ?? "Not summarized yet",
          }))
        )
      }
      if (request.method === "GET" && path === "state")
        return Response.json(await this.snapshot())
      if (request.method === "GET" && path === "search")
        return Response.json(
          this.memory.search((url.searchParams.get("q") ?? "").slice(0, 200))
        )
      if (request.method === "GET" && path === "zoom")
        return Response.json({
          text: this.memory.zoom(
            Number(url.searchParams.get("id")),
            Number(url.searchParams.get("n"))
          ),
        })
      if (request.method === "POST" && path === "import") {
        const body = Schema.decodeUnknownSync(ImportInput)(
          await limitedJson(request, 1_100_000)
        )
        if (this.active())
          return Response.json(
            { error: "Wait for the current reply before importing history." },
            { status: 409 }
          )
        const added = await importHistory(this.memory, body.jsonl)
        await this.compactor.wake()
        await this.backups.wake()
        return Response.json({ added })
      }
      if (request.method === "POST" && path === "send") {
        const body = Schema.decodeUnknownSync(SendInput)(
          await limitedJson(request)
        )
        if (!body.text.trim())
          return Response.json(
            { error: "Write a message first." },
            { status: 400 }
          )
        if (!(await this.credentials.read("openai")))
          return Response.json(
            { error: "Connect ChatGPT before sending a message." },
            { status: 503 }
          )
        const previous = this.db.all<ChatTurn>(
          "SELECT * FROM chat_turns WHERE id=?",
          body.operationId
        )[0]
        if (previous && previous.text !== body.text)
          return Response.json(
            { error: "That operation ID belongs to another message." },
            { status: 409 }
          )
        if (
          !previous &&
          this.db.all<{ n: number }>(
            "SELECT count(*) AS n FROM chat_turns WHERE status IN ('queued','preparing','running')"
          )[0]!.n >= 10
        )
          return Response.json(
            { error: "Wait for the queued messages to finish." },
            { status: 429 }
          )
        // Arm before the synchronous write; a crash cannot strand an accepted turn without a wake.
        await this.runner.wake()
        this.db.run(
          "INSERT OR IGNORE INTO chat_turns(id,text,status,created_at) VALUES (?,?,'queued',?)",
          body.operationId,
          body.text,
          new Date().toISOString()
        )
        return Response.json(
          { accepted: !previous, operationId: body.operationId },
          { status: 202 }
        )
      }
      if (request.method === "POST" && path === "cancel") {
        const { operationId } = Schema.decodeUnknownSync(CancelInput)(
          await limitedJson(request)
        )
        const turn = this.db.all<ChatTurn>(
          "SELECT * FROM chat_turns WHERE id=?",
          operationId
        )[0]
        if (turn && ["queued", "preparing", "running"].includes(turn.status)) {
          this.db.run(
            "UPDATE chat_turns SET status='cancelled' WHERE id=?",
            turn.id
          )
          if (turn.session_id) {
            const session = this.harness.session(turn.session_id)
            await session.abort()
            const entries = await session.messages()
            this.archive(turn, entries)
            this.db.run(
              "UPDATE chat_turns SET answer=? WHERE id=?",
              this.answer(entries),
              turn.id
            )
          }
          this.memory.append(
            `user:${turn.id}`,
            "user",
            turn.text,
            turn.created_at
          )
          this.memory.append(
            `cancel:${turn.id}`,
            "note",
            "The user cancelled this request. Do not continue it without a new instruction."
          )
          await this.compactor.wake()
          await this.backups.wake()
          await this.runner.wake()
        }
        return Response.json({ ok: true })
      }
      return new Response("Not found", { status: 404 })
    } catch {
      return Response.json(
        {
          error:
            "The request could not be completed. Your saved messages are safe.",
        },
        { status: 400 }
      )
    }
  }

  async snapshot(): Promise<ChatState> {
    const turns = this.db.all<ChatTurn>(
      "SELECT * FROM (SELECT * FROM chat_turns ORDER BY rowid DESC LIMIT 100) ORDER BY created_at"
    )
    for (const turn of turns) {
      if (turn.session_id && turn.status === "running") {
        const stream = await this.harness.session(turn.session_id).events()
        try {
          const entries = await this.harness.session(turn.session_id).messages()
          turn.answer = this.answer(entries)
          // Partial provider text is committed by Pi and safe to display, but never summarized.
          const snapshot = stream.snapshot
          if (snapshot.generation?.message)
            turn.answer += textContent(snapshot.generation.message.content)
        } finally {
          await stream.stop()
        }
      }
    }
    return {
      turns: turns.map(
        ({ prompt: _prompt, session_id: _session, ...turn }) => turn
      ),
      model: this.env.MODEL_ID,
      connected: !!(await this.credentials.read("openai")),
      memory: {
        messages: this.memory.total(),
        summaries: this.memory.nodeCount(),
        ready: this.memory.settled(),
        notes: this.memory.notes(),
        backup: this.db.all<{ date: string | null; error: string | null }>(
          "SELECT date,error FROM memory_backup_status WHERE id=1"
        )[0] ?? { date: null, error: null },
        usage: this.db.all<{
          input: number
          cached: number
          output: number
          requests: number
        }>(
          "SELECT coalesce(sum(input),0) AS input,coalesce(sum(cached),0) AS cached,coalesce(sum(output),0) AS output,count(*) AS requests FROM model_usage"
        )[0]!,
      },
    }
  }
  answer(entries: readonly EntryRecord[]) {
    return entries
      .flatMap((entry) => entry.model ?? [])
      .filter((m) => m.role === "assistant")
      .map((m) => textContent(m.content))
      .filter(Boolean)
      .join("\n\n")
  }
  archive(turn: ChatTurn, entries: readonly EntryRecord[]) {
    for (const entry of entries)
      for (const [i, message] of (entry.model ?? []).entries()) {
        const source = `${turn.id}:${entry.id}:${i}`
        if (message.role === "assistant") {
          const text = textContent(message.content)
          if (text) this.memory.append(`${source}:talk`, "talk", text)
          for (const block of message.content)
            if (block.type === "toolCall")
              this.memory.append(
                `${source}:${block.id}`,
                "tool",
                JSON.stringify({ name: block.name, arguments: block.arguments })
              )
        } else if (message.role === "toolResult") {
          this.memory.append(
            `${source}:echo`,
            "echo",
            textContent(message.content)
          )
        }
      }
  }
  async step(): Promise<LifecycleJobOutcome> {
    const turn = this.active()
    if (turn?.status === "queued")
      this.db.run(
        "UPDATE chat_turns SET status='preparing' WHERE id=?",
        turn.id
      )
    if (turn?.status === "running" && turn.session_id) {
      const session = this.harness.session(turn.session_id)
      const before = JSON.stringify(watermark(this.memory))
      this.archive(turn, await session.messages())
      if (before !== JSON.stringify(watermark(this.memory))) {
        await this.compactor.wake()
        await this.backups.wake()
      }
      if ((await this.harness.pending({ session: turn.session_id })).length)
        return { rescheduleAt: Date.now() + 750 }
      const result = await session.wait(turn.id)
      this.archive(turn, await session.messages())
      await this.compactor.wake()
      await this.backups.wake()
      this.db.run(
        "UPDATE chat_turns SET status=?,answer=?,error=? WHERE id=? AND status='running'",
        result.status === "done" ? "done" : "failed",
        this.answer(await session.messages()),
        result.status === "done"
          ? null
          : "The model could not finish. Reconnect ChatGPT if needed, then send your request again.",
        turn.id
      )
      return { rescheduleAt: Date.now() + 10 }
    }
    if (!turn) return undefined
    if (this.current(turn.id).status === "cancelled")
      return { rescheduleAt: Date.now() + 10 }
    if (!this.memory.settled()) {
      await this.compactor.wake()
      return {
        rescheduleAt: Math.max(Date.now() + 750, this.memory.retryAt() ?? 0),
      }
    }
    if (!turn.prompt) {
      this.db.transaction(() => {
        const view = this.memory.render()
        const entry = this.memory.append(
          `user:${turn.id}`,
          "user",
          turn.text,
          turn.created_at
        )
        const notes = this.memory
          .notes()
          .filter((n) => n.path === "MEMORY.md")
          .map((n) => n.body)
          .join("\n")
        const prompt = JSON.stringify([
          { type: "text", text: view },
          {
            type: "text",
            text: `<private-notes>\n${notes}\n</private-notes>\n\nNew user message (archive ID ${entry.id}):\n${turn.text}`,
          },
        ])
        this.db.run(
          "UPDATE chat_turns SET status='preparing',prompt=? WHERE id=?",
          prompt,
          turn.id
        )
        turn.prompt = prompt
      })
    }
    if (!turn.session_id) {
      const session = await this.harness.sessions.create()
      this.db.run(
        "UPDATE chat_turns SET session_id=? WHERE id=?",
        session.id,
        turn.id
      )
      turn.session_id = session.id
    }
    if (this.current(turn.id).status === "cancelled")
      return { rescheduleAt: Date.now() + 10 }
    await this.compactor.wake()
    await this.harness.submit(
      turn.prompt!.startsWith("[")
        ? [
            ...Schema.decodeUnknownSync(
              Schema.Array(
                Schema.Struct({
                  type: Schema.Literal("text"),
                  text: Schema.String,
                })
              )
            )(JSON.parse(turn.prompt!)),
          ]
        : turn.prompt!,
      {
        session: turn.session_id,
        operationId: turn.id,
      }
    )
    this.db.run(
      "UPDATE chat_turns SET status='running' WHERE id=? AND status!='cancelled'",
      turn.id
    )
    if (this.current(turn.id).status === "cancelled")
      await this.harness.session(turn.session_id).abort()
    return { rescheduleAt: Date.now() + 100 }
  }
}

async function limitedJson(
  request: Request,
  limit = 140_000
): Promise<unknown> {
  if (!request.body) throw new Error("Missing body")
  const reader = request.body.getReader(),
    chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.length
      if (size > limit) {
        await reader.cancel()
        throw new Error("Request too large")
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return JSON.parse(new TextDecoder().decode(result))
}

export default {
  fetch(request: Request, env: AgentEnv) {
    // This Worker has no public routes. The authenticated website is its only caller.
    return Effect.runPromise(
      Effect.gen(function* () {
        const owner = request.headers.get("x-owner-id")
        if (!owner) return new Response("Unauthorized", { status: 401 })
        return yield* Effect.tryPromise({
          try: () => env.AGENT.getByName(owner).fetch(request),
          catch: () => new Error("Agent unavailable"),
        }).pipe(
          Effect.catch(() =>
            Effect.succeed(
              Response.json(
                { error: "Agent unavailable. Please retry." },
                { status: 503 }
              )
            )
          )
        )
      })
    )
  },
}
