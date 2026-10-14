import { runActivity } from "../../src/activity/run"
import { InferenceUsage } from "../../src/inference/usage"
import { DurableObject } from "cloudflare:workers"
import { PiHarness } from "agents/harness/pi"
import { Lifecycle } from "agents/lifecycle"
import { Effect } from "effect"
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
import { AccessStore } from "../../src/access/adapters/sqlite"
import { AccessGate } from "../../src/access/gate"
import { guardedTools } from "../../src/access/adapters/pi"
import type { Sqlite } from "../../src/storage/sqlite"

export class LoopBot extends DurableObject<Record<string, never>> {
  readonly db: Sqlite = {
    all: <T>(sql: string, ...args: (string | number | null)[]) =>
      this.ctx.storage.sql.exec(sql, ...args).toArray() as T[],
    run: (sql, ...args) => {
      this.ctx.storage.sql.exec(sql, ...args)
    },
    transaction: (body) => this.ctx.storage.transactionSync(body),
  }
  readonly turns = new ConversationStore(this.db, {
    model: "faux-1",
    thinking: "off",
  })
  readonly usage = new InferenceUsage(this.db)
  readonly recovery = new RunRecoveryStore(this.db)
  readonly access = new AccessStore(this.db, () => [
    { name: "check", description: "Synthetic failure", mode: "allow" },
  ])
  readonly gate = new AccessGate(
    this.access,
    () => this.recovery.get("loop-run")?.view?.phase !== "blocked"
  )
  readonly harness = new PiHarness({
    harness: ({ storage, context }) => {
      const models = createModels()
      const faux = fauxProvider({ tokensPerSecond: 100000 })
      models.setProvider(faux.provider)
      faux.setResponses(
        Array.from({ length: 12 }, () => () => {
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
            source: () => ({ turnId: "loop-run", steeringKey: "original" }),
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
              if (this.recovery.get("loop-run")?.view?.phase === "recovering") {
                while (this.info().hold)
                  await Effect.runPromise(Effect.sleep("50 millis"), {
                    signal: callContext.abortSignal,
                  })
              }
            },
          }),
        ],
        tools: [
          guardedTools(
            this.gate,
            () => "loop-run"
          )(
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
  readonly lifecycle = Lifecycle.install(this).use(this.harness)
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
      if (!this.turns.get("loop-run")) {
        this.turns.admit({ operationId: "loop-run", text: "Synthetic loop" })
        const pi = await this.harness.pi()
        const conversation = await pi.root(BACKGROUND_CONTEXT, {
          agent: { model: { provider: "faux", modelId: "faux-1" } },
        })
        await conversation.configure(
          { model: { provider: "faux", modelId: "faux-1" } },
          BACKGROUND_CONTEXT
        )
        this.turns.saveSession("loop-run", String(conversation.id))
        this.db.run(
          "UPDATE chat_turns SET status='running' WHERE id='loop-run'"
        )
        await this.harness
          .session(String(conversation.id))
          .submit("Check", { operationId: "loop-run" })
      }
    }
    if (path === "/loops/release") this.db.run("UPDATE loop_fixture SET hold=0")
    return Response.json({
      ...this.info(),

      activity: runActivity(
        this.db,
        this.ctx.id.toString(),
        "loop-run",
        this.usage
      ),
      state: this.recovery.get("loop-run"),
      receipts: this.db.all<{ id: string; status: string }>(
        "SELECT id,status FROM tool_operations"
      ),
    })
  }
}
