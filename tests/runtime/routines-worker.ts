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
import { Clock, Context, Effect, Scope } from "effect"

import {
  ConversationRunner,
  observeConversationSchedule,
} from "../../src/conversations/adapters/lifecycle"
import { piConversationLayer } from "../../src/conversations/adapters/pi-execution"
import { sqliteConversationMaterialization } from "../../src/conversations/adapters/sqlite-journal"
import { ConversationStore } from "../../src/conversations/adapters/sqlite-turns"
import { ConversationExecution } from "../../src/conversations/execution"
import { makeConversationJournal } from "../../src/conversations/journal"
import { conversationPump } from "../../src/conversations/pump"
import { makeConversations } from "../../src/conversations/service"
import { sqliteMemoryLayer } from "../../src/memory/adapters/sqlite"
import { MemoryTransaction } from "../../src/memory/ledger"
import { MemoryRepository } from "../../src/memory/repository"
import { RoutineRunner } from "../../src/routines/adapters/lifecycle"
import { SqliteRoutinePersistence } from "../../src/routines/adapters/sqlite"
import type { RoutineRun } from "../../src/routines/contracts"
import { routinePump } from "../../src/routines/pump"
import {
  makeRoutineApplication,
  RoutineAdmissionState,
  Routines,
} from "../../src/routines/service"
import { SqliteWebhookPersistence } from "../../src/webhooks/adapters/sqlite"
import { makeWebhooks } from "../../src/webhooks/service"
import { nativeDatabase } from "./database"

const routineId = "00000000-0000-4000-8000-000000000001"
const saveId = "00000000-0000-4000-8000-000000000002"
const configureId = "00000000-0000-4000-8000-000000000003"
const manualId = "00000000-0000-4000-8000-000000000004"
const pauseId = "00000000-0000-4000-8000-000000000005"
const eventId = "native-event-1"
const keyHash = "a".repeat(64)
const payload = '{"message":"synthetic event"}'
const payloadHash = "b".repeat(64)

type Metrics = {
  lease: number
  calls: number
  submits: number
  admissions: number
  scans: number
  steps: number
  alarms: number
  boots: number
  lostWakes: number
}
class ProbeRoutineRunner extends RoutineRunner<unknown> {
  jobs() {
    return this.lifecycle.jobs.list()
  }
}

/** Production stores, native Pi, scoped pumps and Lifecycle runners. The active
 * bot authority, model availability and model responses are synthetic. Fixture
 * raw SQL only records observations; it never creates application state. */
export class RoutinesProbe extends DurableObject<Record<string, never>> {
  readonly scope = Scope.makeUnsafe()
  readonly db = nativeDatabase(this.ctx.storage, this.scope)
  readonly bundle = makeRoutineApplication(
    new SqliteRoutinePersistence(this.db),
    () => Effect.succeed(true),
    Date.now,
    () => crypto.randomUUID()
  )
  readonly routines = Context.get(this.bundle, Routines)
  readonly webhookRecords = new SqliteWebhookPersistence(this.db)
  readonly webhooks = makeWebhooks(
    this.webhookRecords,
    Context.get(this.bundle, RoutineAdmissionState),
    () => Effect.succeed(true)
  )
  readonly store = new ConversationStore(this.db, {
    model: "faux-routine",
    thinking: "off",
  })
  readonly conversations = makeConversations(this.store)
  readonly memoryBundle = Effect.runSync(
    Effect.gen(function* () {
      return {
        memory: yield* MemoryRepository,
        ledger: yield* MemoryTransaction,
      }
    }).pipe(Effect.provide(sqliteMemoryLayer(this.db)))
  )
  readonly journal = makeConversationJournal(
    this.store,
    this.memoryBundle.ledger,
    sqliteConversationMaterialization(this.db),
    {
      // This isolated fixture proves routine/conversation admission; the Memory
      // native fixtures separately exercise physical maintenance discovery.
      arm: () =>
        Clock.currentTimeMillis.pipe(
          Effect.map((now) => {
            const lease = { deadline: now + 60_000, current: () => true }
            return { summary: lease, backup: lease }
          })
        ),
    }
  )
  private holdDispatch = false
  private holdRoutineDispatch = false
  readonly harness = new PiHarness({
    coordinateStorage: this.db.coordinatePi,
    harness: ({ storage, context }) => {
      const models = createModels(),
        provider = fauxProvider({
          provider: "openai",
          models: [
            { id: "faux-routine", contextWindow: 8192, maxTokens: 1024 },
          ],
          tokensPerSecond: 1000000,
        })
      models.setProvider(provider.provider)
      provider.setResponses(
        Array.from({ length: 20 }, () => async () => {
          this.db.run("UPDATE routines_probe SET calls=calls+1")
          return fauxAssistantMessage("Synthetic routine answer")
        })
      )
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
  readonly native = Effect.runSync(
    ConversationExecution.pipe(
      Effect.provide(
        piConversationLayer(
          () => this.harness,
          () => "faux-routine"
        )
      )
    )
  )
  readonly execution: typeof ConversationExecution.Service = {
    ...this.native,
    submit: (session, turn) =>
      Effect.gen({ self: this }, function* () {
        this.db.run("UPDATE routines_probe SET submits=submits+1")
        yield* this.native.submit(session, turn)
      }),
  }
  readonly conversationPump = conversationPump(
    this.conversations,
    this.memoryBundle.memory,
    this.journal,
    this.execution,
    {
      canRun: (id) => this.routines.canRun(id),
      instructions: () => Effect.succeed("Synthetic routine recovery proof."),
      recovery: () => Effect.succeed(undefined),
      cancelAccess: () => Effect.void,
      awaitingAccess: () => Effect.succeed(false),
      cancelPlan: () => Effect.void,
      reconcileDelegation: () => Effect.void,
      wakeCompaction: () => Effect.void,
      wakeBackup: () => Effect.void,
      wakeBackground: () => Effect.promise(() => this.runner.wake()),
      completed: () => Effect.void,
    }
  )
  readonly conversationRunner: ConversationRunner<unknown> =
    new ConversationRunner<unknown>({
      run: Effect.runPromise,
      step: (onAttempt) =>
        this.holdDispatch
          ? Promise.resolve(Date.now() + 1000)
          : Effect.runPromise(
              this.conversationPump.run("automatic", undefined, onAttempt)
            ),
      exhaust: (attempt, _error, current) =>
        this.store.exhaustControl(
          attempt.rootId,
          attempt.revision,
          attempt.phase,
          "Synthetic native control exhausted",
          current
        ),
      restore: () => this.store.restoreControl(),
      nextWake: () =>
        this.store
          .active()
          .pipe(
            Effect.map((turn) =>
              turn &&
              !turn.control?.unconfirmed &&
              (turn.control?.attempts ?? 0) < 3
                ? Date.now()
                : undefined
            )
          ),
    })
  readonly admission = {
    transactionGroup: this.db,
    admit: (run: RoutineRun, discoveryDeadline: number) =>
      this.store
        .admit(
          { operationId: run.turnId, text: run.prompt },
          undefined,
          [],
          undefined,
          { discoveryDeadline }
        )
        .pipe(
          Effect.tap(() =>
            Effect.sync(() =>
              this.db.run("UPDATE routines_probe SET admissions=admissions+1")
            )
          ),
          Effect.map(({ turn }) => turn.id)
        ),
  }
  readonly pump = routinePump<unknown>(this.routines, {
    getTurn: (id) => this.store.get(id),
    modelConnected: () => Effect.succeed(true),
    canAdmit: () => Effect.succeed(true),
    prearm: () =>
      observeConversationSchedule("arm routine conversation", () =>
        this.conversationRunner.armDiscovery()
      ),
    wakeConversation: () =>
      observeConversationSchedule("wake routine conversation", () =>
        this.conversationRunner.wake()
      ),
    admission: this.admission,
    stop: (id, discoveryDeadline) =>
      this.conversations
        .requestStop(id, { discoveryDeadline })
        .pipe(Effect.asVoid),
    notify: () => Effect.void,
  })
  readonly runner: ProbeRoutineRunner = new ProbeRoutineRunner({
    owner: this.db,
    run: Effect.runPromise,
    step: (onAttempt) => {
      this.db.run("UPDATE routines_probe SET steps=steps+1")
      if (this.holdRoutineDispatch) return Promise.resolve(Date.now() + 1000)
      return Effect.runPromise(
        this.pump.run(onAttempt, { allowDispatch: true })
      )
    },
    nextWake: () =>
      Effect.sync(() =>
        this.db.run("UPDATE routines_probe SET scans=scans+1")
      ).pipe(Effect.andThen(this.routines.nextWake())),
    exhaust: (attempt, current) => this.routines.exhaust(attempt, current),
  })
  readonly lifecycle: Lifecycle = new Lifecycle(this)
    .use(this.harness)
    .use(this.conversationRunner)
    .use(this.runner)
  constructor(ctx: DurableObjectState, env: Record<string, never>) {
    super(ctx, env)
    this.db.run(
      "CREATE TABLE IF NOT EXISTS routines_probe(lease INTEGER,calls INTEGER,submits INTEGER,admissions INTEGER,scans INTEGER,steps INTEGER,alarms INTEGER,boots INTEGER,lostWakes INTEGER)"
    )
    if (!this.db.all("SELECT * FROM routines_probe").length)
      this.db.run("INSERT INTO routines_probe VALUES(0,0,0,0,0,0,0,0,0)")
    this.db.run("UPDATE routines_probe SET boots=boots+1")
  }
  async onStart() {
    await this.conversationRunner.reconcile()
    await this.runner.reconcile()
  }
  async alarm() {
    this.db.run("UPDATE routines_probe SET alarms=alarms+1")
    await this.lifecycle.alarm()
  }
  private metrics() {
    return this.db.all<Metrics>("SELECT * FROM routines_probe")[0]!
  }
  private async seed(deadline: number) {
    await Effect.runPromise(
      this.routines.save(
        {
          id: routineId,
          operationId: saveId,
          expectedRevision: 0,
          title: "Native fixture",
          prompt: "Respond to the synthetic event.",
          schedule: { type: "webhook" },
          status: "active",
        },
        deadline
      )
    )
    await Effect.runPromise(
      this.webhooks.configure({
        routineId,
        operationId: configureId,
        expectedRevision: 0,
        hash: keyHash,
      })
    )
  }
  private accept(deadline: number) {
    return this.webhooks.accept(
      routineId,
      keyHash,
      eventId,
      payload,
      payloadHash,
      deadline
    )
  }
  private manual(deadline: number) {
    return this.routines.runNow(
      { id: routineId, operationId: manualId, expectedRevision: 1 },
      deadline
    )
  }
  private pause() {
    return this.routines.setStatus({
      id: routineId,
      operationId: pauseId,
      expectedRevision: 1,
      status: "paused",
    })
  }
  private async snapshot() {
    // No Lifecycle.start, domain reconciliation or native lookup precedes these
    // reads. An inspect request cannot repair the missing wake negative control.
    const metrics = this.metrics()
    const routines = this.db
      .all<{ record: string }>("SELECT record FROM routines ORDER BY sequence")
      .map((row) => JSON.parse(row.record) as unknown)
    const runs = this.db
      .all<{ record: string }>(
        "SELECT record FROM routine_runs ORDER BY sequence"
      )
      .map((row) => JSON.parse(row.record) as RoutineRun)
    const turns = this.db.all<{
      id: string
      status: string
      session_id: string | null
      answer: string
    }>("SELECT id,status,session_id,answer FROM chat_turns ORDER BY sequence")
    return {
      ...metrics,
      routines,
      runs,
      turns,
      events: this.db.all("SELECT * FROM webhook_events"),
      jobs: this.runner.jobs(),
      wake: await this.ctx.storage.getAlarm(),
    }
  }
  async fetch(request: Request) {
    const url = new URL(request.url),
      path = url.pathname
    if (path === "/inspect") return Response.json(await this.snapshot())
    await this.lifecycle.start()
    let result: unknown
    if (path === "/arm-empty") {
      const lease = await this.runner.armDiscovery()
      this.db.run("UPDATE routines_probe SET lease=?", lease)
    }
    if (path === "/commit") {
      const deadline = this.metrics().lease
      await this.seed(deadline)
      result =
        url.searchParams.get("kind") === "manual"
          ? await Effect.runPromise(this.manual(deadline))
          : await Effect.runPromise(this.accept(deadline))
      // Inject loss of the best-effort postcommit doorbell. The only remaining
      // wake is the production retained-empty routine discovery job.
      try {
        await Promise.reject(new Error("Injected postcommit wake loss"))
      } catch {
        this.db.run("UPDATE routines_probe SET lostWakes=lostWakes+1")
      }
      if (url.searchParams.has("break-wake"))
        await this.ctx.storage.deleteAlarm()
    }
    if (path === "/replay") {
      const deadline = await this.runner.armDiscovery()
      result =
        url.searchParams.get("kind") === "manual"
          ? await Effect.runPromise(this.manual(deadline))
          : await Effect.runPromise(this.accept(deadline))
    }
    if (path === "/conflict") {
      const deadline = await this.runner.armDiscovery()
      result = await Effect.runPromise(
        Effect.result(
          this.webhooks.accept(
            routineId,
            keyHash,
            eventId,
            '{"different":true}',
            "c".repeat(64),
            deadline
          )
        )
      )
    }
    if (path === "/pause-pending" || path === "/pause-admitted") {
      this.holdDispatch = true
      this.holdRoutineDispatch = true
      const deadline = await this.runner.armDiscovery()
      await this.seed(deadline)
      await Effect.runPromise(this.accept(deadline))
      if (path === "/pause-admitted") await Effect.runPromise(this.pump.run())
      await Effect.runPromise(this.pause())
      const run = (await Effect.runPromise(this.routines.runs()))[0]!
      result = {
        canRun: await Effect.runPromise(this.routines.canRun(run.turnId)),
      }
    }
    if (path === "/stop") {
      const run = (await Effect.runPromise(this.routines.runs()))[0]!
      await Effect.runPromise(this.routines.requestStopRun(run.id))
      const canRun = await Effect.runPromise(this.routines.canRun(run.turnId))
      await Effect.runPromise(this.pump.run())
      this.holdDispatch = false
      this.holdRoutineDispatch = false
      await this.conversationRunner.wake()
      await this.runner.wake()
      result = { canRun }
    }
    if (path === "/native") {
      const run = (await Effect.runPromise(this.routines.runs()))[0]!
      const turn = (await Effect.runPromise(this.store.get(run.turnId)))!
      const conversation = await this.harness.conversation(turn.session_id!)
      result = await (
        await this.harness.storage()
      ).submissionByRequest(conversation.id, turn.id, BACKGROUND_CONTEXT)
    }
    return Response.json({ ...(await this.snapshot()), result })
  }
}
export default {
  fetch(request: Request, env: { PROBES: DurableObjectNamespace }) {
    const url = new URL(request.url)
    if (url.pathname === "/health") return new Response("ok")
    return env.PROBES.getByName(
      url.searchParams.get("name") ?? "webhook"
    ).fetch(request)
  },
}
