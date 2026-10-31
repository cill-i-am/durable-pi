import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai"
import { Harness, createRegistry } from "@earendil-works/pi-durable"
import { PiHarness } from "agents/harness/pi"
import { Lifecycle } from "agents/lifecycle"
import { DurableObject } from "cloudflare:workers"
import { Clock, Effect, Exit, Scope } from "effect"

import {
  ConversationRunner,
  observeConversationSchedule,
} from "../../src/conversations/adapters/lifecycle"
import {
  conversationNativeOperation,
  piConversationLayer,
} from "../../src/conversations/adapters/pi-execution"
import { sqliteConversationMaterialization } from "../../src/conversations/adapters/sqlite-journal"
import { ConversationStore } from "../../src/conversations/adapters/sqlite-turns"
import {
  checkConversationReply,
  retryConversationStop,
  stopConversation,
} from "../../src/conversations/commands"
import {
  ConversationExecution,
  ConversationExecutionError,
} from "../../src/conversations/execution"
import { makeConversationJournal } from "../../src/conversations/journal"
import { conversationPump } from "../../src/conversations/pump"
import { makeConversations } from "../../src/conversations/service"
import { ConversationConflict } from "../../src/conversations/turns"
import { sqliteMemoryLayer } from "../../src/memory/adapters/sqlite"
import { MemoryTransaction } from "../../src/memory/ledger"
import { MemoryRepository } from "../../src/memory/repository"
import { nativeDatabase } from "./database"

function rejectedConflict(exit: Exit.Exit<unknown, unknown>) {
  if (!Exit.isFailure(exit)) return false
  if (
    !exit.cause.reasons.length ||
    exit.cause.reasons.some(
      (reason) =>
        reason._tag !== "Fail" ||
        !(reason.error instanceof ConversationConflict)
    )
  )
    throw exit.cause
  return true
}

class ProbeRunner extends ConversationRunner<unknown> {
  jobs() {
    return this.lifecycle.jobs.list()
  }
  async restartAt(time: number) {
    for (const job of this.lifecycle.jobs.list())
      await this.lifecycle.jobs.reschedule(job.id, time)
  }
}
type ProbeMetrics = {
  calls: number
  submitCalls: number
  abortCalls: number
  configureCalls: number
  automatic: number
  steps: number
}

/** Production domain store, materialization, native Pi adapter, scoped pump and
 * Lifecycle capability. Only model responses and failure barriers are synthetic.
 * No unrelated background alarm can hide a missing conversation discovery wake. */
export class ConversationControlProbe extends DurableObject<
  Record<string, never>
> {
  readonly scope = Scope.makeUnsafe()
  readonly db = nativeDatabase(this.ctx.storage, this.scope)
  readonly store = new ConversationStore(this.db, {
    model: "faux-conversation",
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
      // This isolated fixture proves conversation control; Memory maintenance
      // discovery is exercised by the dedicated Memory native host.
      arm: () =>
        Clock.currentTimeMillis.pipe(
          Effect.map((now) => {
            const lease = { deadline: now + 60_000, current: () => true }
            return { summary: lease, backup: lease }
          })
        ),
    }
  )
  readonly harness = new PiHarness({
    coordinateStorage: this.db.coordinatePi,
    harness: ({ storage, context }) => {
      const models = createModels(),
        provider = fauxProvider({
          provider: "openai",
          models: [
            { id: "faux-conversation", contextWindow: 8192, maxTokens: 1024 },
          ],
          tokensPerSecond: 1000000,
        })
      models.setProvider(provider.provider)
      provider.setResponses(
        Array.from({ length: 20 }, () => async () => {
          this.db.run("UPDATE conversation_probe_metrics SET calls=calls+1")
          return fauxAssistantMessage("Synthetic conversation answer")
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
          () => "faux-conversation"
        )
      )
    )
  )
  mode = "normal"
  holdAlarm = false
  holdEntered = false
  settled = false
  failure: string | undefined
  private releaseHeld?: () => void
  private controller?: AbortController
  private pending?: Promise<unknown>
  readonly execution: typeof ConversationExecution.Service = {
    ...this.native,
    configure: (session, turn) =>
      Effect.suspend(() => {
        this.db.run(
          "UPDATE conversation_probe_metrics SET configureCalls=configureCalls+1"
        )
        if (this.mode === "exhaustion") {
          if (this.metrics().configureCalls === 3)
            this.db.run(
              "CREATE TRIGGER IF NOT EXISTS conversation_probe_release_fault BEFORE UPDATE ON chat_turns WHEN json_extract(OLD.control,'$.owner') IS NOT NULL AND json_extract(NEW.control,'$.owner') IS NULL BEGIN SELECT RAISE(ABORT,'synthetic control release unavailable'); END"
            )
          return Effect.fail(
            new ConversationExecutionError({
              operation: "configure",
              cause: "synthetic transport unavailable",
            })
          )
        }
        return this.native.configure(session, turn)
      }),
    submit: (session, turn) =>
      Effect.gen({ self: this }, function* () {
        this.db.run(
          "UPDATE conversation_probe_metrics SET submitCalls=submitCalls+1"
        )
        yield* this.native.submit(session, turn)
        if (this.mode === "lost-ack" || this.mode === "held-submit") {
          // Native acceptance and final result are durable before the adapter's
          // acknowledgement is lost. This is not an exactly-once provider claim
          // for a crash in the middle of inference.
          yield* conversationNativeOperation(
            "await native synthetic result",
            () => this.harness.session(session).wait(turn.id)
          )
          yield* this.hold("submit acknowledgement")
        }
      }),
    abort: (session) =>
      Effect.gen({ self: this }, function* () {
        if (this.mode === "held-abort") yield* this.hold("abort dispatch")
        if (this.mode === "stop-failure")
          return yield* new ConversationExecutionError({
            operation: "abort",
            cause: "synthetic abort transport unavailable",
          })
        this.db.run(
          "UPDATE conversation_probe_metrics SET abortCalls=abortCalls+1"
        )
        yield* this.native.abort(session)
      }),
  }
  readonly pump = conversationPump(
    this.conversations,
    this.memoryBundle.memory,
    this.journal,
    this.execution,
    {
      canRun: () => Effect.succeed(true),
      instructions: () => Effect.succeed("Synthetic native recovery proof."),
      recovery: () => Effect.succeed(undefined),
      cancelAccess: () => Effect.void,
      awaitingAccess: () => Effect.succeed(false),
      cancelPlan: () => Effect.void,
      reconcileDelegation: () => Effect.void,
      wakeCompaction: () => Effect.void,
      wakeBackup: () => Effect.void,
      wakeBackground: () => Effect.void,
      completed: () => Effect.void,
    }
  )
  readonly runner: ProbeRunner = new ProbeRunner({
    run: (work) => Effect.runPromise(work),
    step: async (onAttempt) => {
      this.db.run("UPDATE conversation_probe_metrics SET steps=steps+1")
      return Effect.runPromise(this.pump.run("automatic", undefined, onAttempt))
    },
    exhaust: (attempt, _error, eligible) =>
      this.store.exhaustControl(
        attempt.rootId,
        attempt.revision,
        attempt.phase,
        "Synthetic control exhausted; Check or Retry Stop.",
        eligible
      ),
    restore: () =>
      Effect.gen({ self: this }, function* () {
        yield* this.store.restoreControl()
        const active = yield* this.store.active()
        if (active?.control?.unconfirmed && active.session_id) {
          const outcome = yield* Effect.exit(
            this.pump.run("inspect", {
              id: active.id,
              revision: active.revision,
            })
          )
          if (Exit.isFailure(outcome))
            yield* Effect.logError(
              "Synthetic cold inspection remains unconfirmed",
              outcome.cause
            )
        }
      }),
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
  readonly lifecycle: Lifecycle<Record<string, never>> = new Lifecycle(this)
    .use(this.harness)
    .use(this.runner)
  readonly commandHost = {
    prearm: () =>
      observeConversationSchedule("arm conversation", () =>
        this.runner.armDiscovery()
      ),
    wake: () =>
      observeConversationSchedule("wake conversation", () =>
        this.runner.wake()
      ),
    wakeBackground: () => Effect.void,
    notify: () => Effect.void,
  }
  readonly stop = stopConversation(this.conversations, this.commandHost)
  readonly retryStop = retryConversationStop(
    this.conversations,
    this.commandHost
  )
  readonly check = checkConversationReply({
    inspect: (id, revision) => this.pump.run("inspect", { id, revision }),
    notify: () => Effect.void,
  })
  constructor(ctx: DurableObjectState, env: Record<string, never>) {
    super(ctx, env)
    this.db.run(
      "CREATE TABLE IF NOT EXISTS conversation_probe_metrics(calls INTEGER,submitCalls INTEGER,abortCalls INTEGER,configureCalls INTEGER,automatic INTEGER,steps INTEGER)"
    )
    if (!this.db.all("SELECT * FROM conversation_probe_metrics").length)
      this.db.run("INSERT INTO conversation_probe_metrics VALUES(0,0,0,0,0,0)")
    this.db.run(
      "CREATE TABLE IF NOT EXISTS conversation_probe_lease(deadline INTEGER NOT NULL)"
    )
  }
  async onStart() {
    await this.runner.reconcile()
  }
  async alarm() {
    if (this.holdAlarm) return
    this.db.run("UPDATE conversation_probe_metrics SET automatic=automatic+1")
    await this.lifecycle.alarm()
  }
  private hold(operation: string) {
    return conversationNativeOperation(operation, async (signal) => {
      this.holdEntered = true
      await new Promise<void>((done) => {
        this.releaseHeld = done
      })
      if (this.mode === "held-submit")
        throw new ConversationExecutionError({
          operation,
          cause: "synthetic late handoff failure after fresh Stop",
        })
      signal.throwIfAborted()
    })
  }
  private metrics() {
    return this.db.all<ProbeMetrics>(
      "SELECT * FROM conversation_probe_metrics"
    )[0]!
  }
  private deadline() {
    return this.db.all<{ deadline: number }>(
      "SELECT deadline FROM conversation_probe_lease"
    )[0]?.deadline
  }
  private async arm() {
    const deadline = await this.runner.armDiscovery()
    this.db.run("DELETE FROM conversation_probe_lease")
    this.db.run("INSERT INTO conversation_probe_lease VALUES(?)", deadline)
    return deadline
  }
  private admit(id = "synthetic-root") {
    return Effect.runPromise(
      this.store.admit(
        { operationId: id, text: `Synthetic ${id}` },
        undefined,
        [],
        undefined,
        { discoveryDeadline: this.deadline()! }
      )
    )
  }
  private startPass() {
    this.controller = new AbortController()
    this.settled = false
    this.pending = Effect.runPromiseExit(this.pump.run(), {
      signal: this.controller.signal,
    }).then((exit) => {
      this.settled = true
      if (Exit.isFailure(exit)) this.failure = String(exit.cause)
    })
    this.ctx.waitUntil(this.pending)
  }
  snapshot() {
    const rows = this.db
      .all<Record<string, unknown>>(
        "SELECT * FROM chat_turns ORDER BY sequence"
      )
      .map((row) => ({
        ...row,
        control: JSON.parse(String(row.control)) as unknown,
      }))
    const tables = this.db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='pi_submissions'"
    )
    const native = tables.length
      ? this.db
          .all<{ record: string }>(
            "SELECT record FROM pi_submissions ORDER BY id"
          )
          .map((row) => JSON.parse(row.record) as unknown)
      : []
    return {
      rows,
      native,
      jobs: this.runner.jobs(),
      metrics: this.metrics(),
      state: {
        holdEntered: this.holdEntered,
        settled: this.settled,
        failure: this.failure,
      },
      now: Date.now(),
      deadline: this.deadline(),
    }
  }
  private async observedSnapshot() {
    return {
      ...this.snapshot(),
      physicalAlarm: await this.ctx.storage.getAlarm(),
    }
  }
  private async heldAction(action: string | undefined) {
    if (action === "start-pass") this.startPass()
    if (action === "stop") {
      await Effect.runPromise(this.stop("synthetic-root"))
      this.controller?.abort()
    }
    if (action === "fail-stop") {
      this.holdAlarm = true
      this.mode = "stop-failure"
      await Effect.runPromise(this.stop("synthetic-root"))
    }
    if (action === "interrupt") this.controller?.abort()
    if (action === "release") {
      this.releaseHeld?.()
      await this.pending
      this.mode = "normal"
    }
  }
  async fetch(request: Request) {
    const action = new URL(request.url).pathname.split("/").at(-1)
    // Raw status never starts Lifecycle/Pi, restores a domain row, or rings a
    // doorbell. It cannot rescue a broken no-request alarm proof.
    if (action === "status") return Response.json(await this.observedSnapshot())
    await this.lifecycle.start()
    const input = await request.json<{
      mode?: string
      revision?: number
      id?: string
    }>()
    if (action === "arm") {
      this.holdAlarm = true
      await this.arm()
      await this.lifecycle.alarm() // The real queue's early empty scan.
    }
    if (action === "admit-lost-wake") await this.admit()
    if (action === "setup") {
      this.holdAlarm = true
      this.mode = input.mode ?? "normal"
      await this.arm()
      await this.admit()
      if (this.mode === "held-abort") {
        this.mode = "normal"
        await Effect.runPromise(this.pump.run())
        await this.harness
          .session(
            (await Effect.runPromise(this.store.get("synthetic-root")))!
              .session_id!
          )
          .wait("synthetic-root")
        this.mode = "held-abort"
        await Effect.runPromise(this.stop("synthetic-root"))
      }
    }
    await this.heldAction(action)
    if (action === "pump") await Effect.runPromiseExit(this.pump.run())
    if (action === "wake") await this.runner.wake()
    if (action === "dispatch") await this.lifecycle.alarm()
    if (action === "arm-restart") {
      await this.runner.restartAt(Date.now() + 2000)
      // Drain the completed Pi task's native wake while the application claim
      // remains held. Only the future Conversation wake should remain at kill.
      await this.lifecycle.alarm()
    }
    if (action === "heal") {
      this.db.run("DROP TRIGGER IF EXISTS conversation_probe_release_fault")
      this.mode = "normal"
    }
    if (action === "check") {
      const outcome = await Effect.runPromiseExit(
        this.check("synthetic-root", input.revision!)
      )
      if (rejectedConflict(outcome))
        return Response.json({
          ...(await this.observedSnapshot()),
          rejected: true,
        })
    }
    if (action === "retry-stop") {
      const outcome = await Effect.runPromiseExit(
        this.retryStop("synthetic-root", input.revision!)
      )
      if (rejectedConflict(outcome))
        return Response.json({
          ...(await this.observedSnapshot()),
          rejected: true,
        })
    }
    if (action === "new-root") {
      await this.arm()
      const outcome = await Effect.runPromiseExit(
        this.store.resumeMessage(
          {
            operationId: input.id ?? "synthetic-next",
            text: "Synthetic addressed continuation",
            origin: {
              kind: "coordination",
              turnId: "synthetic-root",
              messageId: "synthetic-message",
            },
          },
          { discoveryDeadline: this.deadline()! }
        )
      )
      if (rejectedConflict(outcome))
        return Response.json({
          ...(await this.observedSnapshot()),
          rejected: true,
        })
    }
    return Response.json(await this.observedSnapshot())
  }
}

export default {
  async fetch(
    request: Request,
    env: { CONVERSATIONS: DurableObjectNamespace<ConversationControlProbe> }
  ) {
    const [name] = new URL(request.url).pathname.split("/").filter(Boolean)
    if (name === "health") return Response.json({ ready: true })
    return env.CONVERSATIONS.get(
      env.CONVERSATIONS.idFromName(name ?? "default")
    ).fetch(request)
  },
}
