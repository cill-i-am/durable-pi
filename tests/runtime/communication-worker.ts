import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai"
import { Harness, createRegistry } from "@earendil-works/pi-durable"
import { PiHarness } from "agents/harness/pi"
import {
  Lifecycle,
  LifecycleCapability,
  type LifecycleJobOutcome,
} from "agents/lifecycle"
import { DurableObject } from "cloudflare:workers"
import { Effect, Exit, Layer, Schema, Scope } from "effect"

import { agentGateway } from "../../src/agent/adapters/gateway"
import { agentSettings } from "../../src/agent/compaction"
import { agentObjectName } from "../../src/agents/domain"
import { agentProxy } from "../../src/auth/adapters/agent-proxy"
import { piMailbox } from "../../src/communication/adapters/pi"
import {
  mailboxHandler,
  mailboxTransport,
  isMailboxRequest,
} from "../../src/communication/adapters/rpc"
import { sqliteMailbox } from "../../src/communication/adapters/sqlite"
import { Envelope, Identity, failure } from "../../src/communication/contracts"
import { deliverNext } from "../../src/communication/delivery"
import { MailboxTransport, Mailbox } from "../../src/communication/mailbox"
import { executionWorkerRequest } from "../../src/execution/worker"
import { resolveRoute } from "../../src/inference/policy"
import { runObserved } from "../../src/observability/worker"
import { BackgroundGroupProbe } from "./background-worker"
import { BrowserRecoveryBot } from "./browser-worker"
import { nativeDatabase } from "./database"
import { eventStreamProbe } from "./event-stream-worker"
import { LoopBot } from "./loop-worker"
import { PersonalAgentProbe } from "./personal-agent-worker"
import { SqlitePilot } from "./sqlite-worker"
import { TerminalProbe } from "./terminal-worker"

export {
  LoopBot,
  BrowserRecoveryBot,
  PersonalAgentProbe,
  BackgroundGroupProbe,
  TerminalProbe,
  SqlitePilot,
}

interface Env {
  SQL_PILOT: DurableObjectNamespace<SqlitePilot>
  LOADER: WorkerLoader
  PERSONAL: DurableObjectNamespace<PersonalAgentProbe>
  BACKGROUND: DurableObjectNamespace<BackgroundGroupProbe>
  TERMINALS: DurableObjectNamespace<TerminalProbe>
  BROWSERS: DurableObjectNamespace<BrowserRecoveryBot>
  LOOPS: DurableObjectNamespace<LoopBot>
  BOTS: DurableObjectNamespace<MailboxBot>
}
class Pump extends LifecycleCapability {
  constructor(readonly bot: MailboxBot) {
    super("communication")
  }
  async arm() {
    await this.lifecycle.jobs.push({
      id: "communication:pump",
      fn: "pump",
      time: Date.now() + 1000,
      singleflight: true,
      recoveryLoop: true,
      hungTimeoutSeconds: 30,
    })
  }
  async onJob(): Promise<LifecycleJobOutcome> {
    return this.bot.pump()
  }
}
class OtherCapability extends LifecycleCapability {
  constructor(readonly bot: MailboxBot) {
    super("unrelated")
  }
  async arm() {
    await this.lifecycle.jobs.push({
      id: "unrelated:checkpoint",
      fn: "checkpoint",
      time: Date.now() + 500,
    })
  }
  onJob() {
    this.bot.db.run("INSERT INTO fixture_events(value) VALUES ('unrelated')")
  }
}
export class MailboxBot extends DurableObject<Env> {
  readonly storageScope = Effect.runSync(Scope.make())
  readonly db = nativeDatabase(this.ctx.storage, this.storageScope)
  readonly repository = sqliteMailbox(this.db)
  readonly mailbox = Effect.runSync(this.repository.initialize)
  readonly transport = mailboxTransport(this.env.BOTS, (e) =>
    Effect.gen({ self: this }, function* () {
      const self = yield* this.mailbox.identity()
      if (self.owner !== e.owner || self.bot !== e.to)
        return yield* Effect.fail(
          failure("forbidden", "Owner or recipient mismatch.")
        )
    })
  )
  readonly services = Layer.merge(
    Layer.succeed(Mailbox, this.mailbox),
    this.transport
  )
  readonly models = createModels()
  readonly harness = new PiHarness({
    coordinateStorage: this.db.coordinatePi,
    harness: ({ storage, context }) => {
      const faux = fauxProvider({
        provider: "openai",
        models: [{ id: "gpt-6-luna", contextWindow: 8192, maxTokens: 2048 }],
        tokensPerSecond: 1000000,
      })
      this.models.setProvider(faux.provider)
      faux.setResponses(
        Array.from({ length: 10 }, () => async (_, options) => {
          await Effect.runPromise(this.pi.request(options!.sessionId!), {
            signal: options?.signal,
          })
          this.db.run("INSERT INTO fixture_events(value) VALUES ('pi-request')")
          while (this.fault("hold-pi"))
            await Effect.runPromise(Effect.sleep("50 millis"), {
              signal: options?.signal,
            })
          return fauxAssistantMessage("Native Pi result: 4")
        })
      )
      return Harness.open(
        storage,
        {
          models: this.models,
          registry: createRegistry(),
          settings: agentSettings(() =>
            this.models.getModel("openai", "gpt-6-luna")
          ),
        },
        context
      )
    },
  })
  readonly pi = piMailbox(
    () => this.harness.pi(),
    {
      submit: (id, text, operationId) =>
        this.harness
          .session(String(id))
          .submit(text, { operationId, whenBusy: "followUp" }),
      abort: (id) => this.harness.session(String(id)).abort(),
    },
    this.mailbox,
    Effect.runSync(Effect.provide(MailboxTransport, this.transport)),
    () =>
      Effect.succeed({
        name: "Synthetic bot",
        instructions: "No outside actions",
        route: {
          ...resolveRoute("conversation", {
            model: "gpt-6-luna",
            thinking: "low",
          }),
          contextWindow: 8192,
        },
      })
  )
  readonly jobs = new Pump(this)
  readonly other = new OtherCapability(this)
  readonly lifecycle = Lifecycle.install(this)
    .use(this.harness)
    .use(this.jobs)
    .use(this.other)
    .use(
      new (class extends LifecycleCapability {
        constructor(private readonly scope: Scope.Closeable) {
          super("fixture-database")
        }
        async dispose() {
          await Effect.runPromise(Scope.close(this.scope, Exit.void))
        }
      })(this.storageScope)
    )
  readonly rpc = mailboxHandler(
    this.mailbox,
    this.transport,
    () =>
      Effect.tryPromise({
        try: () => this.jobs.arm(),
        catch: () => failure("storage", "Could not arm mailbox."),
      }),
    (e) =>
      Effect.gen({ self: this }, function* () {
        if (!(yield* this.mailbox.prove(e))) return false
        const task = yield* this.mailbox.task(e.taskId)
        return !task.cancelRequested && task.status === "waiting"
      })
  )
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.db.run(
      "CREATE TABLE IF NOT EXISTS fixture_events(value TEXT NOT NULL)"
    )
    this.db.run(
      "CREATE TABLE IF NOT EXISTS fixture_faults(name TEXT PRIMARY KEY,value INTEGER NOT NULL)"
    )
  }
  setFault(name: string, value: number) {
    this.db.run(
      "INSERT INTO fixture_faults VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
      name,
      value
    )
  }
  fault(name: string) {
    return (
      this.db.all<{ value: number }>(
        "SELECT value FROM fixture_faults WHERE name=?",
        name
      )[0]?.value ?? 0
    )
  }
  async onStart() {
    if ((await Effect.runPromise(this.mailbox.nextWake())) !== undefined)
      await this.jobs.arm()
  }
  async configure(raw: unknown) {
    const identity = Schema.decodeUnknownSync(Identity)(raw)
    if (
      !this.ctx.id.equals(
        this.env.BOTS.idFromName(agentObjectName(identity.owner, identity.bot))
      )
    )
      throw new Error("Wrong fixture identity")
    await Effect.runPromise(this.repository.bindIdentity(identity))
  }
  async enqueue(raw: unknown, delay: number) {
    const e = Schema.decodeUnknownSync(Envelope)(raw)
    await this.jobs.arm()
    await this.other.arm()
    const d = await Effect.runPromise(this.mailbox.enqueue(e, Date.now()))
    if (delay)
      this.db.run(
        "UPDATE communication_outbox SET next_at=? WHERE id=?",
        Date.now() + delay,
        e.id
      )
    return d
  }
  async pump() {
    await Effect.runPromise(deliverNext().pipe(Effect.provide(this.services)))
    const task = await Effect.runPromise(this.mailbox.claimTask(Date.now()))
    if (task) {
      const outcome = this.fault("native-pi")
        ? await Effect.runPromise(this.pi.advance(task))
        : task.cancelRequested
          ? {
              status: "cancelled" as const,
              text: "Cancelled before deterministic execution.",
            }
          : task.request.deadline <= Date.now()
            ? { status: "expired" as const, text: "Task deadline passed." }
            : { status: "completed" as const, text: "Deterministic result: 4" }
      if (outcome) {
        await Effect.runPromise(
          this.mailbox.finish(task.id, task.revision, outcome, Date.now())
        )
        const resultDelay = this.fault("result-delay")
        if (resultDelay)
          this.db.run(
            "UPDATE communication_outbox SET next_at=? WHERE id=?",
            Date.now() + resultDelay,
            `result:${task.id}`
          )
        this.db.run("INSERT INTO fixture_events(value) VALUES ('execution')")
      }
    }
    for (const pending of await Effect.runPromise(this.mailbox.pending())) {
      if (pending.direction === "outgoing" && pending.outcome)
        await Effect.runPromise(
          this.mailbox.resume(pending.id, {
            transactionGroup: this.db,
            operationId: `fixture:${pending.id}`,
            admit: () =>
              Effect.sync(() => {
                this.db.run(
                  "INSERT INTO fixture_events(value) VALUES ('continuation')"
                )
                return {
                  kind: "admitted" as const,
                  turnId: `fixture:${pending.id}`,
                }
              }),
          })
        )
    }
    const next = await Effect.runPromise(this.mailbox.nextWake())
    return next === undefined
      ? undefined
      : { rescheduleAt: Math.max(Date.now() + 100, next) }
  }
  async inspect() {
    return {
      tasks: await Effect.runPromise(this.mailbox.tasks()),
      deliveries: await Effect.runPromise(this.mailbox.deliveries()),
      executions: await Effect.runPromise(
        Effect.forEach(
          (await Effect.runPromise(this.mailbox.tasks())).filter(
            (t) => t.direction === "incoming"
          ),
          (t) => this.pi.inspect(t.id)
        )
      ),
      events: this.db.all<{ value: string }>(
        "SELECT value FROM fixture_events"
      ),
    }
  }
  async fetch(request: Request) {
    await this.lifecycle.start()
    if (!isMailboxRequest(request))
      return new Response("Not found", { status: 404 })
    const isDelivery = (await request.clone().text()).includes(
      '"tag":"deliver"'
    )
    const response = await this.rpc(request)
    if (isDelivery && this.fault("drop-ack") > 0) {
      await response.arrayBuffer()
      this.setFault("drop-ack", this.fault("drop-ack") - 1)
      this.db.run(
        "INSERT INTO fixture_events(value) VALUES ('lost-ack-after-commit')"
      )
      return new Response("Simulated lost acknowledgment", { status: 503 })
    }
    return response
  }
}
let websiteSessionValid = true
let websiteSessionReads = 0
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url)
    if (url.pathname.startsWith("/encoding/"))
      return eventStreamProbe(request, ctx)
    if (url.pathname.startsWith("/sql-pilot/"))
      return env.SQL_PILOT.getByName(url.pathname.split("/")[2]!).fetch(request)
    if (url.pathname === "/website-session") {
      if (request.method === "POST") websiteSessionValid = false
      return Response.json({
        valid: websiteSessionValid,
        reads: websiteSessionReads,
      })
    }
    if (url.pathname === "/website-probe")
      return env.PERSONAL.getByName("gateway-owner").fetch(
        new Request("https://probe/inspect")
      )
    if (url.pathname.startsWith("/website/")) {
      const headers = new Headers(request.headers)
      headers.set("origin", "https://website.example")
      return agentProxy(
        new Request(
          new Request(
            `https://website.example/api/agent/${url.pathname.slice(9)}${url.search}`,
            request
          ),
          { headers }
        ),
        {
          appUrl: "https://website.example",
          owner: Effect.sync(() => {
            websiteSessionReads++
            return websiteSessionValid ? { id: "gateway-owner" } : null
          }),
          forward: (forwarded) =>
            agentGateway(forwarded, { AGENT: env.PERSONAL }, ctx),
          own: (pending) => ctx.waitUntil(pending),
        }
      )
    }
    if (url.pathname.startsWith("/gateway/")) {
      const headers = new Headers(request.headers)
      headers.set("x-owner-id", "gateway-owner")
      return agentGateway(
        new Request(
          `https://agent.internal/api/agent/${url.pathname.slice(9)}${url.search}`,
          {
            method: request.method,
            headers,
            signal: request.signal,
            body: request.method === "GET" ? undefined : request.body,
          }
        ),
        { AGENT: env.PERSONAL },
        ctx
      )
    }
    if (url.pathname.startsWith("/native-terminal/"))
      return env.TERMINALS.getByName("native-terminal-direct").fetch(
        new Request(
          `https://terminal.internal/${url.pathname.slice(17)}`,
          request
        )
      )
    if (url.pathname === "/native-execution")
      return executionWorkerRequest(
        new Request("https://execution.internal/run", request),
        env.LOADER
      )
    if (url.pathname.startsWith("/browser/"))
      return env.BROWSERS.getByName(url.pathname).fetch(request)
    if (url.pathname.startsWith("/loops/"))
      return env.LOOPS.getByName("loop-test").fetch(request)
    if (url.pathname.startsWith("/personal-credential/"))
      return env.PERSONAL.getByName("personal-credential-owner").fetch(request)
    if (url.pathname.startsWith("/personal-code/"))
      return env.PERSONAL.getByName("personal-code-owner").fetch(request)
    if (url.pathname.startsWith("/personal-terminal/"))
      return env.PERSONAL.getByName("personal-terminal-owner").fetch(request)
    if (url.pathname.startsWith("/personal/"))
      return env.PERSONAL.getByName("personal-owner").fetch(request)
    if (url.pathname === "/health") return new Response("local fixture")
    if (url.pathname === "/telemetry")
      return runObserved(
        Effect.gen(function* () {
          const parent = yield* Effect.currentSpan
          const child = yield* Effect.gen(function* () {
            yield* Effect.sleep("1 millis")
            const span = yield* Effect.currentSpan
            return {
              name: span.name,
              id: span.spanId,
              parent:
                span.parent._tag === "Some" ? span.parent.value.spanId : null,
            }
          }).pipe(Effect.withSpan("fixture.child"))
          return Response.json({ id: parent.spanId, name: parent.name, child })
        }).pipe(Effect.withSpan("fixture.request"))
      )
    if (request.method !== "POST")
      return new Response("Not found", { status: 404 })
    return mailboxFixtureRequest(request, env)
  },
}

export { LegacyAgentProbe } from "./legacy-agent-worker"

async function mailboxFixtureRequest(request: Request, env: Env) {
  const url = new URL(request.url)
  const input = await request.json<{
    identity: unknown
    envelope: unknown
    delay?: number
    name?: string
    value?: number
  }>()
  const identity = Schema.decodeUnknownSync(Identity)(input.identity)
  const bot = env.BOTS.getByName(agentObjectName(identity.owner, identity.bot))
  if (url.pathname === "/configure") {
    await bot.configure(identity)
    return Response.json({ ok: true })
  }
  if (url.pathname === "/enqueue")
    return Response.json(await bot.enqueue(input.envelope, input.delay ?? 0))
  if (url.pathname === "/inspect") return Response.json(await bot.inspect())
  if (url.pathname === "/fault") {
    await bot.setFault(input.name!, input.value!)
    return Response.json({ ok: true })
  }
  if (url.pathname === "/raw")
    return bot.fetch(
      new Request("http://alchemy-rpc/", {
        method: "POST",
        headers: { "content-type": "application/ndjson" },
        body:
          JSON.stringify({
            _tag: "Request",
            id: "test-rpc",
            tag: "deliver",
            payload: { envelope: input.envelope },
            headers: [],
          }) + "\n",
      })
    )
  return new Response("Not found", { status: 404 })
}
