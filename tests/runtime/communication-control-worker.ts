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
  type LifecycleJobContext,
  type LifecycleJobOutcome,
} from "agents/lifecycle"
import { DurableObject } from "cloudflare:workers"
import { Clock, Effect, Exit, Layer, Schema, Scope } from "effect"

import { agentSettings } from "../../src/agent/compaction"
import { agentObjectName } from "../../src/agents/domain"
import { WebCryptoContinuationIdentity } from "../../src/communication/adapters/identity"
import {
  CommunicationRunner,
  observeCommunicationSchedule,
} from "../../src/communication/adapters/lifecycle"
import { piMailbox } from "../../src/communication/adapters/pi"
import {
  mailboxHandler,
  mailboxTransport,
  isMailboxRequest,
} from "../../src/communication/adapters/rpc"
import { sqliteMailbox } from "../../src/communication/adapters/sqlite"
import { makeCommunication } from "../../src/communication/communication"
import {
  Envelope,
  Identity,
  failure,
  type CommunicationError,
} from "../../src/communication/contracts"
import { TaskExecution } from "../../src/communication/execution"
import { MailboxTransport, Mailbox } from "../../src/communication/mailbox"
import { resolveRoute } from "../../src/inference/policy"
import { nativeDatabase } from "./database"

interface Env {
  BOTS: DurableObjectNamespace<MailboxBot>
}
class ProbeRunner extends CommunicationRunner<CommunicationError> {
  afterFailure?: () => Promise<void>
  async onJobError(
    context: LifecycleJobContext,
    error: unknown
  ): Promise<LifecycleJobOutcome> {
    const outcome = await super.onJobError(context, error)
    // Exact installed-driver crash window: production persistence has joined,
    // but Lifecycle has not yet received the outcome or applied queue retirement.
    await this.afterFailure?.()
    return outcome
  }
  rawRecovery() {
    return this.lifecycle.storage.get("bot-communication:failure")
  }
  rearm() {
    return this.lifecycle.jobs.rearm()
  }

  jobs() {
    return this.lifecycle.jobs.list()
  }
  async restartAt(time: number) {
    for (const job of this.lifecycle.jobs.list())
      if (job.capability === "bot-communication")
        await this.lifecycle.jobs.reschedule(job.id, time)
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
    this.bot.event("unrelated")
  }
}

/** Actual Communication, runner, SQLite ledger, Pi bridge and Lifecycle queue.
 * Synthetic model output and explicit native boundary holds are the only work
 * substitutes. Raw snapshots never start Lifecycle/Pi or create a wake. */
export class MailboxBot extends DurableObject<Env> {
  readonly storageScope = Effect.runSync(Scope.make())
  readonly db = nativeDatabase(this.ctx.storage, this.storageScope)
  readonly repository = sqliteMailbox(this.db)
  readonly mailbox = Effect.runSync(this.repository.initialize)
  readonly transport = mailboxTransport(this.env.BOTS, (e) =>
    Effect.gen({ self: this }, function* () {
      const self = yield* this.mailbox.identity()
      if (self.owner !== e.owner || self.bot !== e.to)
        return yield* failure("forbidden", "Owner or recipient mismatch.")
    })
  )
  readonly transportService = Effect.runSync(
    Effect.provide(MailboxTransport, this.transport)
  )
  readonly models = createModels()
  readonly harness = new PiHarness({
    coordinateStorage: this.db.coordinatePi,
    harness: async ({ storage, context }) => {
      const faux = fauxProvider({
        provider: "openai",
        models: [{ id: "gpt-6-luna", contextWindow: 8192, maxTokens: 2048 }],
        tokensPerSecond: 1000000,
      })
      this.models.setProvider(faux.provider)
      faux.setResponses(
        Array.from({ length: 20 }, () => async (_, options) => {
          await Effect.runPromise(this.pi.request(options!.sessionId!), {
            signal: options?.signal,
          })
          options?.signal?.throwIfAborted()
          this.event("pi-request")
          while (this.fault("hold-pi"))
            await Effect.runPromise(Effect.sleep("50 millis"), {
              signal: options?.signal,
            })
          return fauxAssistantMessage("Native Pi result: 4")
        })
      )
      const harness = await Harness.open(
        storage,
        {
          models: this.models,
          registry: createRegistry(),
          settings: {
            ...agentSettings(() =>
              this.models.getModel("openai", "gpt-6-luna")
            ),
            retry: { enabled: false },
          },
        },
        context
      )
      await Effect.runPromise(this.pi.restore(harness))
      return harness
    },
  })
  readonly pi = piMailbox(
    () => this.harness.pi(),
    {
      submit: async (id, text, operationId) => {
        this.event("submit")
        const session = this.harness.session(String(id))
        const receipt = await session.submit(text, {
          operationId,
          whenBusy: "followUp",
        })
        if (this.fault("hold-submit-ack")) {
          await session.wait(operationId)
          await this.hold("submit")
        }
        return receipt
      },
      abort: async (id) => {
        this.event("abort-entered")
        if (this.fault("hold-abort")) await this.hold("abort")
        await this.harness.session(String(id)).abort()
        this.event("abort-confirmed")
      },
    },
    this.mailbox,
    this.transportService,
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
  readonly execution: TaskExecution["Service"] = {
    advance: (task) =>
      Effect.suspend(() =>
        this.fault("native-pi")
          ? this.pi.advance(task)
          : Effect.succeed(
              task.cancelRequested
                ? {
                    status: "cancelled" as const,
                    text: "Cancelled before deterministic execution.",
                  }
                : task.request.deadline <= Date.now()
                  ? {
                      status: "expired" as const,
                      text: "Task deadline passed.",
                    }
                  : {
                      status: "completed" as const,
                      text: "Deterministic result: 4",
                    }
            )
      ),
    settled: (id) =>
      this.pi.settled(id).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (
              this.db.all("SELECT id FROM fixture_executions WHERE id=?", id)
                .length
            )
              return
            this.ctx.storage.transactionSync(() => {
              this.db.run("INSERT INTO fixture_executions VALUES(?)", id)
              const delay = this.fault("result-delay")
              if (delay) this.delay(`result:${id}`, delay)
              this.event("execution")
            })
          })
        )
      ),
  }
  readonly app = Effect.runSync(
    makeCommunication({
      transactionGroup: this.db,
      contacts: () => Effect.succeed([]),
      recovery: () =>
        observeCommunicationSchedule("read fixture recovery", () =>
          this.runner.recovery()
        ),
      armRecovery: (epoch) =>
        observeCommunicationSchedule("arm fixture recovery", () =>
          this.runner.armRecovery(epoch)
        ),
      retryRecovery: (epoch, deadline) =>
        observeCommunicationSchedule("retry fixture recovery", () =>
          this.runner.retryRecovery(epoch, deadline)
        ),
      reconcileQueue: () =>
        observeCommunicationSchedule("reconcile fixture queue", () =>
          this.runner.reconcileQueue()
        ),
      prepare: () => Effect.void,
      current: () => Effect.succeed("done" as const),
      wake: () =>
        observeCommunicationSchedule("wake fixture mailbox", () =>
          this.runner.wake()
        ),
      armMailbox: () =>
        observeCommunicationSchedule("arm fixture mailbox", () =>
          this.runner.armDiscovery()
        ),
      prearm: () => Effect.succeed(Date.now() + 60_000),
      wakeConversation: () => Effect.void,
      idle: () => Effect.succeed(true),
      resume: (_task, operationId) =>
        Effect.sync(() => {
          this.event("continuation")
          return { kind: "admitted" as const, turnId: operationId }
        }),
      notify: () => {},
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(Mailbox, this.mailbox),
          this.transport,
          Layer.succeed(TaskExecution, this.execution),
          WebCryptoContinuationIdentity
        )
      )
    )
  )
  readonly runner: ProbeRunner = new ProbeRunner({
    run: (work) => Effect.runPromise(work),
    step: (onAttempt) =>
      Effect.runPromise(
        Effect.suspend(() => {
          if (this.fault("fail-unowned-pump")) {
            this.event("unowned-pump-attempt")
            return Effect.fail(
              failure("storage", "Synthetic failure before any domain claim.")
            )
          }
          return this.app.pump(onAttempt)
        })
      ),
    exhaust: (attempt, _error, eligible) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          this.mailbox.exhaustControl(attempt, now, eligible)
        )
      ),
    restore: () =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => this.mailbox.restoreControl(now))
      ),
    nextWake: () => this.mailbox.nextWake(),
  })
  readonly other = new OtherCapability(this)
  readonly lifecycle: Lifecycle<Env> = new Lifecycle(this)
    .use(this.harness)
    .use(this.runner)
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
      observeCommunicationSchedule("arm mailbox receipt", () =>
        this.runner.armDiscovery()
      ),
    (e) =>
      Effect.gen({ self: this }, function* () {
        if (!(yield* this.mailbox.prove(e))) return false
        const task = yield* this.mailbox.task(e.taskId)
        return !task.cancelRequested && task.status === "waiting"
      })
  )
  holdAlarm = false
  held: string | null = null
  private releaseHeld?: () => void
  private controller?: AbortController
  private passes: Promise<unknown>[] = []
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.runner.afterFailure = async () => {
      if (this.fault("hold-recovery-outcome"))
        await this.hold("recovery-outcome")
    }
    this.db.run(
      "CREATE TABLE IF NOT EXISTS fixture_events(value TEXT NOT NULL)"
    )
    this.db.run(
      "CREATE TABLE IF NOT EXISTS fixture_faults(name TEXT PRIMARY KEY,value INTEGER NOT NULL)"
    )
    this.db.run(
      "CREATE TABLE IF NOT EXISTS fixture_executions(id TEXT PRIMARY KEY)"
    )
  }
  event(value: string) {
    this.db.run("INSERT INTO fixture_events(value) VALUES (?)", value)
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
  private delay(id: string, delay: number) {
    const nextAt = Date.now() + delay
    // Fault instrumentation changes the authoritative JSON and its index in one
    // statement, preserving the strict versioned projection invariant.
    this.db.run(
      "UPDATE communication_outbox SET body=json_set(body,'$.nextAt',?),next_at=? WHERE id=?",
      nextAt,
      nextAt,
      id
    )
  }
  private async hold(kind: string) {
    this.held = kind
    this.event(`${kind}-held`)
    await new Promise<void>((done) => {
      this.releaseHeld = done
    })
    this.held = null
  }
  async onStart() {
    await this.runner.reconcile()
  }
  async alarm() {
    if (this.holdAlarm) return
    this.event("automatic")
    await this.lifecycle.alarm()
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
    await this.lifecycle.start()
  }
  async enqueue(raw: unknown, delay: number, unrelated = true) {
    await this.lifecycle.start()
    const e = Schema.decodeUnknownSync(Envelope)(raw)
    const discoveryDeadline = await this.runner.armDiscovery()
    if (unrelated) await this.other.arm()
    const d = await Effect.runPromise(
      this.mailbox.enqueue(e, Date.now(), { discoveryDeadline })
    )
    if (delay) this.delay(e.id, delay)
    await this.runner.wake()
    return d
  }
  private startPass() {
    const controller = new AbortController()
    this.controller ??= controller
    const pending = Effect.runPromiseExit(this.app.pump(), {
      signal: controller.signal,
    }).then((exit) => {
      this.event("pass-settled")
      if (Exit.isFailure(exit)) this.event(`pass-failure:${String(exit.cause)}`)
    })
    this.passes.push(pending)
    this.ctx.waitUntil(pending)
  }
  async snapshot() {
    const native = this.db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='pi_submissions'"
    ).length
      ? this.db
          .all<{ record: string }>(
            "SELECT record FROM pi_submissions ORDER BY id"
          )
          .map((row) => JSON.parse(row.record) as unknown)
      : []
    return {
      tasks: await Effect.runPromise(this.mailbox.tasks()),
      deliveries: await Effect.runPromise(this.mailbox.deliveries()),
      events: this.db.all<{ value: string }>(
        "SELECT value FROM fixture_events"
      ),
      native,
      inbox: this.db
        .all<{ id: string; content: string; receipt: string }>(
          "SELECT id,content,receipt FROM communication_inbox ORDER BY id"
        )
        .map((row) => ({
          id: row.id,
          content: JSON.parse(row.content) as unknown,
          receipt: JSON.parse(row.receipt) as unknown,
        })),
      jobs: this.runner.jobs(),
      recoveryState: (await this.runner.rawRecovery()) ?? null,
      sdkRows: this.db
        .all<{
          id: string
          capability: string
          fn: string
          time: number
          payload: string | null
          running: number
          execution_started_at: number | null
          hung_timeout_seconds: number | null
        }>(
          "SELECT id,capability,fn,time,payload,running,execution_started_at,hung_timeout_seconds FROM cf_agents_jobs WHERE capability='bot-communication' ORDER BY id"
        )
        .map((row) => ({
          ...row,
          payload:
            row.payload === null ? null : (JSON.parse(row.payload) as unknown),
        })),
      physicalAlarm: await this.ctx.storage.getAlarm(),
      pins: this.pi.pins(),
      held: this.held,
      now: Date.now(),
      deadline: this.fault("discovery-deadline"),
    }
  }
  async inspect() {
    return {
      ...(await this.snapshot()),
      executions: await Effect.runPromise(
        Effect.forEach(
          (await Effect.runPromise(this.mailbox.tasks())).filter(
            (t) => t.direction === "incoming"
          ),
          (t) => this.pi.inspect(t.id)
        )
      ),
    }
  }
  private async recoveryControl(action: string, raw: { epoch?: string }) {
    if (action === "recovery-dispatch") {
      const pending = this.lifecycle.alarm()
      this.passes.push(pending)
      this.ctx.waitUntil(pending)
    }
    if (action === "recovery-crash") {
      // Accelerate only the SDK's existing hung-row revisit. Do not recreate,
      // release or replace the running queue row or its payload/epoch.
      this.db.run(
        "UPDATE cf_agents_jobs SET hung_timeout_seconds=1 WHERE id='bot-communication:pump' AND running=1"
      )
      await this.runner.rearm()
    }
    if (action === "recovery-read")
      return {
        ...(await this.snapshot()),
        mailbox: await Effect.runPromise(this.app.read()),
      }
    if (action === "recovery-retry") {
      const result = await Effect.runPromiseExit(
        this.app.retryMailbox(raw.epoch!)
      )
      return {
        ...(await this.snapshot()),
        accepted: Exit.isSuccess(result),
        failures: Exit.isFailure(result)
          ? result.cause.reasons.flatMap((reason) =>
              reason._tag === "Fail" ? [reason.error] : []
            )
          : [],
      }
    }
    return this.snapshot()
  }
  async control(
    action: string,
    raw: { envelope?: unknown; taskId?: string; epoch?: string }
  ) {
    if (action === "snapshot") return this.snapshot()
    await this.lifecycle.start()
    if (action.startsWith("recovery-")) return this.recoveryControl(action, raw)
    if (action === "hold-alarms") this.holdAlarm = true
    if (action === "arm-empty") {
      this.holdAlarm = true
      this.setFault("discovery-deadline", await this.runner.armDiscovery())
      await this.lifecycle.alarm()
    }
    if (action === "admit-lost-wake")
      await Effect.runPromise(
        this.mailbox.enqueue(
          Schema.decodeUnknownSync(Envelope)(raw.envelope),
          Date.now(),
          { discoveryDeadline: this.fault("discovery-deadline") }
        )
      )
    if (action === "pass") this.startPass()
    if (action === "pump") await Effect.runPromise(this.app.pump())
    if (action === "stop") {
      await Effect.runPromise(this.app.cancel(raw.taskId!))
      this.controller?.abort()
    }
    if (action === "release") {
      this.setFault("hold-submit-ack", 0)
      this.setFault("hold-abort", 0)
      this.releaseHeld?.()
      await Promise.all(this.passes)
      this.passes = []
      this.controller = undefined
    }
    if (action === "interrupt") this.controller?.abort()
    if (action === "wake") await this.runner.wake()
    if (action === "dispatch") await this.lifecycle.alarm()
    if (action === "arm-restart") {
      await this.runner.restartAt(Date.now() + 2000)
      await this.lifecycle.alarm()
    }
    if (action === "permit-model") {
      const execution = await Effect.runPromise(this.pi.inspect(raw.taskId!))
      if (!execution) throw new Error("Missing native fixture execution")
      const exit = await Effect.runPromiseExit(
        this.pi.request(execution.provider)
      )
      return { ...(await this.snapshot()), permitted: Exit.isSuccess(exit) }
    }
    return this.snapshot()
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
      this.event("lost-ack-after-commit")
      return new Response("Simulated lost acknowledgment", { status: 503 })
    }
    return response
  }
}

export async function mailboxFixtureRequest(request: Request, env: Env) {
  const url = new URL(request.url)
  const input = await request.json<{
    identity: unknown
    envelope?: unknown
    delay?: number
    name?: string
    value?: number
    taskId?: string
    epoch?: string
    unrelated?: boolean
  }>()
  const identity = Schema.decodeUnknownSync(Identity)(input.identity)
  const bot = env.BOTS.getByName(agentObjectName(identity.owner, identity.bot))
  if (url.pathname === "/configure") {
    await bot.configure(identity)
    return Response.json({ ok: true })
  }
  if (url.pathname === "/enqueue")
    return Response.json(
      await bot.enqueue(
        input.envelope,
        input.delay ?? 0,
        input.unrelated ?? true
      )
    )
  if (url.pathname === "/inspect") return Response.json(await bot.inspect())
  if (url.pathname === "/fault") {
    await bot.setFault(input.name!, input.value!)
    return Response.json({ ok: true })
  }
  if (url.pathname.startsWith("/control/"))
    return Response.json(await bot.control(url.pathname.slice(9), input))
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
export default {
  fetch(request: Request, env: Env) {
    if (new URL(request.url).pathname === "/health")
      return new Response("local fixture")
    return mailboxFixtureRequest(request, env)
  },
}
