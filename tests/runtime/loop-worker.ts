import { projectRunActivity } from "../../src/activity/run"
import { SqliteActivityRecords } from "../../src/activity/adapters/sqlite"
import { InferenceUsage, usageApplication } from "../../src/inference/usage"
import { SqliteUsage } from "../../src/inference/adapters/usage-sqlite"
import { DurableObject } from "cloudflare:workers"
import { PiHarness } from "agents/harness/pi"
import { Lifecycle, LifecycleCapability } from "agents/lifecycle"
import { Effect, Exit, Scope } from "effect"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import {
  Harness,
  GenerationTask,
  hook,
  createRegistry,
  defineTool,
} from "@earendil-works/pi-durable"
import {
  Type,
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai"
import { ConversationStore } from "../../src/conversations/adapters/sqlite-turns"
import { RunRecoveryStore } from "../../src/conversations/adapters/sqlite-recovery"
import { runRecoveryHook } from "../../src/conversations/adapters/pi-recovery"
import { AccessStorageError } from "../../src/access/contracts"
import { AccessStore } from "../../src/access/adapters/sqlite"
import { AccessGate } from "../../src/access/gate"
import { guardedTools } from "../../src/access/adapters/pi"
import { nativeDatabase } from "./database"

export class LoopBot extends DurableObject<Record<string, never>> {
  readonly databaseScope = Scope.makeUnsafe()
  readonly db = nativeDatabase(this.ctx.storage, this.databaseScope)
  readonly turns = new ConversationStore(this.db, {
    model: "faux-1",
    thinking: "off",
  })
  readonly usage = Effect.runSync(
    InferenceUsage.pipe(
      Effect.provide(
        usageApplication(new SqliteUsage(this.db), () => crypto.randomUUID())
      )
    )
  )
  readonly recovery = new RunRecoveryStore(this.db)
  readonly access = new AccessStore(this.db, () =>
    Effect.succeed([
      { name: "check", description: "Synthetic failure", mode: "allow" },
    ])
  )
  readonly gate = new AccessGate(this.access, () =>
    this.recovery.get("loop-run").pipe(
      Effect.map((state) => state?.view?.phase !== "blocked"),
      Effect.mapError(
        (cause) =>
          new AccessStorageError({ operation: "loop authority", cause })
      )
    )
  )
  readonly harness = new PiHarness({
    coordinateStorage: this.db.coordinatePi,
    harness: ({ storage, context }) => {
      const models = createModels()
      const faux = fauxProvider({ tokensPerSecond: 100000 })
      models.setProvider(faux.provider)
      faux.setResponses(
        Array.from({ length: 12 }, () => async () => {
          this.db.run("UPDATE loop_fixture SET requests=requests+1")
          const n = this.info().requests
          return fauxAssistantMessage(
            fauxToolCall("check", { value: "bad" }, { id: `call-${n}` }),
            { stopReason: "toolUse" }
          )
        })
      )
      const registry = createRegistry()
      registry.install({
        name: "test",
        hooks: [
          runRecoveryHook({
            storage,
            store: this.recovery,
            access: this.access,
            source: () =>
              Effect.succeed({ turnId: "loop-run", steeringKey: "original" }),
            stop: async (api, callContext) => {
              await (await (
                await this.harness.pi()
              ).conversation(api.conversationId, callContext))!.abort(
                callContext
              )
            },
          }),
          hook(GenerationTask, {
            afterTools: async (_a, _r, _api, callContext) => {
              if (
                (await Effect.runPromise(this.recovery.get("loop-run")))?.view
                  ?.phase === "recovering"
              ) {
                while (this.info().hold)
                  await Effect.runPromise(Effect.sleep("50 millis"), {
                    signal: callContext.abortSignal,
                  })
              }
            },
          }),
        ],
        tools: [
          guardedTools(this.gate, () => Effect.succeed("loop-run"))(
            defineTool({
              name: "check",
              description: "Synthetic failure",
              parameters: Type.Object({ value: Type.String() }),
              replay: "safe",
              execute: async () => ({
                content: [{ type: "text", text: "Synthetic failure" }],
                isError: true,
              }),
            })
          ),
        ],
      })
      return Harness.open(
        storage,
        {
          models,
          registry,
          settings: {
            compaction: { enabled: false },
            retry: { enabled: false },
          },
        },
        context
      )
    },
  })
  readonly lifecycle = Lifecycle.install(this)
    .use(this.harness)
    .use(
      new (class extends LifecycleCapability {
        constructor(private readonly scope: Scope.Closeable) {
          super("fixture-database")
        }
        async dispose() {
          await Effect.runPromise(Scope.close(this.scope, Exit.void))
        }
      })(this.databaseScope)
    )
  constructor(ctx: DurableObjectState, env: Record<string, never>) {
    super(ctx, env)
    this.db.run(
      "CREATE TABLE IF NOT EXISTS loop_fixture(requests INTEGER,hold INTEGER)"
    )
    if (!this.db.all("SELECT * FROM loop_fixture").length)
      this.db.run("INSERT INTO loop_fixture VALUES (0,1)")
  }
  info() {
    return this.db.all<{ requests: number; hold: number }>(
      "SELECT * FROM loop_fixture"
    )[0]!
  }
  async fetch(request: Request) {
    await this.lifecycle.start()
    const path = new URL(request.url).pathname
    if (path === "/loops/start") {
      if (!(await Effect.runPromise(this.turns.get("loop-run")))) {
        await Effect.runPromise(
          this.turns.admit({ operationId: "loop-run", text: "Synthetic loop" })
        )
        const pi = await this.harness.pi()
        const conversation = await pi.root(BACKGROUND_CONTEXT, {
          agent: { model: { provider: "faux", modelId: "faux-1" } },
        })
        await conversation.configure(
          { model: { provider: "faux", modelId: "faux-1" } },
          BACKGROUND_CONTEXT
        )
        await Effect.runPromise(
          this.turns.saveSession("loop-run", String(conversation.id))
        )
        this.db.run(
          "UPDATE chat_turns SET status='running' WHERE id='loop-run'"
        )
        await this.harness
          .session(String(conversation.id))
          .submit("Check", { operationId: "loop-run" })
      }
    }
    if (path === "/loops/release") this.db.run("UPDATE loop_fixture SET hold=0")
    const activity = await Effect.runPromise(
      new SqliteActivityRecords(this.db).run("loop-run", null)
    )
    return Response.json({
      ...this.info(),
      activity: activity
        ? projectRunActivity(
            activity,
            this.ctx.id.toString(),
            "loop-run",
            await Effect.runPromise(this.usage.totals("loop-run")),
            Date.now()
          )
        : null,
      state: await Effect.runPromise(this.recovery.get("loop-run")),
      receipts: this.db.all<{ id: string; status: string }>(
        "SELECT id,status FROM tool_operations"
      ),
    })
  }
}
