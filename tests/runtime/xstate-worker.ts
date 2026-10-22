import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai"
import { Harness, createRegistry } from "@earendil-works/pi-durable"
import { PiHarness } from "agents/harness/pi"
import { Lifecycle } from "agents/lifecycle"
import { DurableObject } from "cloudflare:workers"
import { eq } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Effect, Schema, Scope } from "effect"

import {
  decideSubmission,
  newSubmission,
  SubmissionState,
  SubmitCommand,
} from "../lifecycle/submission.machine"
import { nativeDatabase } from "./database"

const rows = sqliteTable("xstate_reference", {
  id: integer("id").primaryKey(),
  value: text("value").notNull(),
})
const FixtureRecord = Schema.Struct({
  state: SubmissionState,
  command: Schema.NullOr(SubmitCommand),
  session: Schema.String,
  receipt: Schema.NullOr(Schema.Number),
  events: Schema.Record(Schema.String, Schema.String),
})
type FixtureRecord = typeof FixtureRecord.Type

/** A bounded native conformance fixture, not a second workflow framework. */
export class XStateProbe extends DurableObject<Record<string, never>> {
  // Failure injection only: hold alarm dispatch until this process is killed.
  // Native Pi can settle the lost-ack case, but neither fixture can commit its
  // application result before the restart even on a slow CI machine.
  private holdDispatchUntilRestart = false
  readonly scope = Scope.makeUnsafe()
  readonly db = nativeDatabase(this.ctx.storage, this.scope)
  readonly harness = new PiHarness({
    coordinateStorage: this.db.coordinatePi,
    harness: ({ storage, context }) => {
      const models = createModels()
      const provider = fauxProvider({ tokensPerSecond: 100000 })
      models.setProvider(provider.provider)
      provider.setResponses([
        async () => {
          this.db.run("UPDATE xstate_metrics SET calls=calls+1")
          return fauxAssistantMessage("Prepared")
        },
      ])
      return Harness.open(
        storage,
        {
          models,
          registry: createRegistry(),
          settings: {
            compaction: { enabled: false },
            retry: { enabled: false },
          },
        },
        context
      )
    },
  })
  readonly lifecycle: Lifecycle = new Lifecycle(this).use(this.harness)
  constructor(ctx: DurableObjectState, env: Record<string, never>) {
    super(ctx, env)
    // Fixture-only DDL/instrumentation; production uses generated migrations.
    this.db.run(
      "CREATE TABLE IF NOT EXISTS xstate_reference(id INTEGER PRIMARY KEY,value TEXT NOT NULL)"
    )
    this.db.run(
      "CREATE TABLE IF NOT EXISTS xstate_metrics(calls INTEGER,dispatches INTEGER,mode TEXT)"
    )
    if (!this.db.all("SELECT * FROM xstate_metrics").length)
      this.db.run("INSERT INTO xstate_metrics VALUES(0,0,'normal')")
  }
  alarm(): Promise<void> {
    return this.lifecycle.alarm()
  }
  read = () =>
    this.db
      .use((orm) => orm.select().from(rows).where(eq(rows.id, 1)))
      .pipe(
        Effect.map((found) =>
          found[0]
            ? Schema.decodeUnknownSync(FixtureRecord)(
                JSON.parse(found[0].value)
              )
            : undefined
        )
      )
  save = (record: FixtureRecord) =>
    this.db.use((orm) =>
      orm
        .insert(rows)
        .values({ id: 1, value: JSON.stringify(record) })
        .onConflictDoUpdate({
          target: rows.id,
          set: { value: JSON.stringify(record) },
        })
    )
  metrics() {
    return this.db.all<{ calls: number; dispatches: number; mode: string }>(
      "SELECT * FROM xstate_metrics"
    )[0]!
  }
  async arm() {
    await this.lifecycle.jobs.push({
      id: "submission",
      fn: "reconcile",
      time: Date.now() + 1000,
      singleflight: true,
      retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
    })
  }
  async admit(content: string, mode: string) {
    const existing = await Effect.runPromise(this.read())
    if (existing) {
      if (existing.state.context.content !== content)
        throw new Error("Conflicting operation identity")
      return
    }
    this.holdDispatchUntilRestart = true
    const pi = await this.harness.pi()
    const conversation = await pi.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: "faux", modelId: "faux-1" } },
    })
    await conversation.configure(
      { model: { provider: "faux", modelId: "faux-1" } },
      BACKGROUND_CONTEXT
    )
    this.db.run("UPDATE xstate_metrics SET mode=?", mode)
    // Pre-arm BEFORE accepting the application intent. A post-commit crash needs no request.
    if (mode !== "broken-wake") await this.arm()
    await Effect.runPromise(
      this.db.transaction(() =>
        Effect.gen({ self: this }, function* () {
          const current = yield* this.read()
          if (current) {
            if (current.state.context.content !== content)
              throw new Error("Conflicting operation identity")
            return
          }
          const event = {
            type: "SUBMIT",
            revision: 0,
            generation: 1,
            attempt: 1,
          } as const
          const decision = decideSubmission(
            newSubmission("reference:1", content, Date.now() + 10_000),
            event
          )
          yield* this.save({
            state: decision.state,
            command: decision.commands[0]!,
            session: String(conversation.id),
            receipt: null,
            events: { submit: JSON.stringify(event) },
          })
        })
      )
    )
    if (mode === "lost-ack") await this.dispatch(true)
  }
  async dispatch(loseAck = false) {
    const saved = await Effect.runPromise(this.read())
    if (!saved?.command || saved.state.value !== "pending") return
    const { command } = saved
    // Authority is re-read at the consequential boundary; no earlier guard grants future permission.
    if (
      command.generation !== saved.state.context.generation ||
      command.attempt !== saved.state.context.attempt
    )
      throw new Error("Stale dispatch authority")
    this.db.run("UPDATE xstate_metrics SET dispatches=dispatches+1")
    await this.harness
      .session(saved.session)
      .submit(command.content, { operationId: command.operationId })
    const conversation = await this.harness.conversation(saved.session)
    const native = await (
      await this.harness.storage()
    ).submissionByRequest(
      conversation.id,
      command.operationId,
      BACKGROUND_CONTEXT
    )
    if (!native) throw new Error("Missing native submission")
    if (loseAck) {
      // Kill after Pi persists its result, before the application records receipt.
      // A kill during model inference may legitimately repeat that model request.
      await this.harness.session(saved.session).wait(command.operationId)
      return
    }
    await Effect.runPromise(
      this.db.transaction(() =>
        Effect.gen({ self: this }, function* () {
          const current = yield* this.read()
          if (!current || current.state.value !== "pending") return
          yield* this.save({ ...current, receipt: native.id })
        })
      )
    )
    if (native.status === "unanswered") {
      await this.unconfirmed()
      return
    }
    if (native.status !== "done") return
    await Effect.runPromise(
      this.db.transaction(() =>
        Effect.gen({ self: this }, function* () {
          const current = yield* this.read()
          if (!current) throw new Error("Missing application intent")
          const event = {
            type: "COMPLETED",
            revision: 1,
            generation: command.generation,
            attempt: command.attempt,
          } as const
          const eventId = `result:${native.id}`
          const previous = current.events[eventId]
          if (previous && previous !== JSON.stringify(event))
            throw new Error("Conflicting event identity")
          if (previous) return
          const next = decideSubmission(current.state, event)
          yield* this.save({
            ...current,
            state: next.state,
            events: { ...current.events, [eventId]: JSON.stringify(event) },
          })
        })
      )
    )
  }
  async unconfirmed(now?: number) {
    await Effect.runPromise(
      this.db.transaction(() =>
        Effect.gen({ self: this }, function* () {
          const current = yield* this.read()
          if (!current || current.state.value !== "pending") return
          const { revision, attempt, generation } = current.state.context
          const fence = { revision, attempt, generation }
          const event =
            now === undefined
              ? ({ type: "UNCONFIRMED", ...fence } as const)
              : ({ type: "TIMEOUT", now, ...fence } as const)
          const next = decideSubmission(current.state, event)
          if (next.state.value !== current.state.value)
            yield* this.save({
              ...current,
              state: next.state,
              events: { ...current.events, unconfirmed: JSON.stringify(event) },
            })
        })
      )
    )
  }
  async onJob() {
    if (this.holdDispatchUntilRestart) return { rescheduleAt: Date.now() + 100 }
    await this.unconfirmed(Date.now())
    try {
      await this.dispatch()
    } catch {
      // No transport failure authorizes another business attempt. If storage is
      // also down, this write fails and Lifecycle retains its own retry policy.
      await this.unconfirmed()
    }
    const current = await Effect.runPromise(this.read())
    // A pre-armed wake can run before the first commit; it must retain discovery.
    if (!current || current.state.value === "pending")
      return { rescheduleAt: Date.now() + 100 }
  }
  async fetch(request: Request): Promise<Response> {
    await this.lifecycle.start()
    const url = new URL(request.url)
    if (url.pathname === "/admit")
      await this.admit(
        url.searchParams.get("content") ?? "Prepare",
        url.searchParams.get("mode") ?? "normal"
      )
    const record = await Effect.runPromise(this.read())
    return Response.json({
      record,
      ...this.metrics(),
      wake: await this.ctx.storage.getAlarm(),
      jobs: this.lifecycle.jobs.list(),
    })
  }
}

export default {
  fetch(request: Request, env: { PROBES: DurableObjectNamespace }) {
    const url = new URL(request.url)
    if (url.pathname === "/health") return new Response("ok")
    const name = url.searchParams.get("name") ?? "reference"
    return env.PROBES.get(env.PROBES.idFromName(name)).fetch(request)
  },
}
