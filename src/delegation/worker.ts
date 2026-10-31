import { Harness, createRegistry } from "@earendil-works/pi-durable"
import { PiHarness } from "agents/harness/pi"

import "../observability/lifecycle"
import { Lifecycle, LifecycleCapability } from "agents/lifecycle"
import { DurableObject } from "cloudflare:workers"
import {
  Scheduler,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Schema,
  Scope,
} from "effect"

import type { AgentEnv } from "../../alchemy.run"
import { agentSettings } from "../agent/compaction"
import type { PersonalAgent } from "../agent/worker"
import {
  accountRpc,
  nativeAccountToken,
} from "../inference/adapters/account-rpc"
import { accountCredentials } from "../inference/adapters/credentials-pi"
import { createAgentModels } from "../inference/adapters/models-pi"
import {
  PiModelStreams,
  piModelStreamsLayer,
  modelCallback,
} from "../inference/adapters/streams-pi"
import { piUsage } from "../inference/adapters/usage-pi"
import { SqliteUsage } from "../inference/adapters/usage-sqlite"
import { InferenceUsage, usageApplication } from "../inference/usage"
import { reportInference, reportHarness } from "../observability/events"
import { preserveFatal } from "../shared/effect"
import { makeDurableObjectSqlite } from "../storage/durable-object"
import { migrateSqlite } from "../storage/migrations"
import { backgroundParentRpc } from "./adapters/background-parent"
import {
  piBackgroundLedger,
  readBackgroundHandoff,
} from "./adapters/background-pi"
import {
  BackgroundRequest,
  BackgroundResult,
  backgroundReply,
  BackgroundOutcome,
} from "./adapters/background-protocol"
import { backgroundNative } from "./adapters/interop"
import { BackgroundHandoff, backgroundObjectName } from "./background"
import { BackgroundTasks, backgroundTasksApplication } from "./background-tasks"
import type { Group, Transcript, DelegationFailure } from "./contracts"

export type BackgroundControlResult =
  | { ok: true; accepted: boolean }
  | { ok: false; code: DelegationFailure["code"]; message: string }

export interface BackgroundGroupRPC extends Rpc.DurableObjectBranded {
  invokeV1: (request: unknown) => Promise<Schema.Json>
  start: (parentObject: string, id: number) => Promise<Group>
  read: () => Promise<Group>
  stop: () => Promise<void>
  control: (raw: unknown) => Promise<BackgroundControlResult>
  transcript: (child: number, cursor?: string) => Promise<Transcript>
}

class BackgroundServices extends LifecycleCapability {
  constructor(readonly owner: BackgroundGroup) {
    super("effect-services")
  }
  async dispose() {
    await Effect.runPromise(
      this.owner.runtime
        .runSync(PiModelStreams)
        .shutdown()
        .pipe(
          Effect.ensuring(this.owner.runtime.disposeEffect),
          Effect.ensuring(Scope.close(this.owner.databaseScope, Exit.void))
        )
    )
  }
}

export class BackgroundGroup
  extends DurableObject<AgentEnv>
  implements BackgroundGroupRPC
{
  private pin?: BackgroundHandoff
  readonly databaseScope = Scope.makeUnsafe()
  readonly db = Effect.runSync(
    Effect.gen({ self: this }, function* () {
      const db = yield* makeDurableObjectSqlite(this.ctx.storage)
      yield* migrateSqlite(db)
      return db
    }).pipe(
      Effect.provideService(Scope.Scope, this.databaseScope),
      Effect.provideService(Scheduler.PreventSchedulerYield, true)
    )
  )
  readonly runtime = ManagedRuntime.make(
    Layer.mergeAll(
      usageApplication(new SqliteUsage(this.db), () => crypto.randomUUID()),
      piModelStreamsLayer,
      backgroundTasksApplication(
        piBackgroundLedger(() => this.harness.pi(), {
          submit: (child, text, operationId, steer) =>
            this.harness.session(String(child)).submit(text, {
              operationId,
              whenBusy: steer ? "steer" : "followUp",
            }),
          abort: (child) => this.harness.session(String(child)).abort(),
        }),
        {
          authorized: (handoff) =>
            backgroundNative(() =>
              backgroundParentRpc(
                this.env.AGENT.get(
                  this.env.AGENT.idFromString(handoff.parentObject)
                )
              ).authorized(handoff.id)
            ),
        }
      )
    )
  )
  readonly usage = this.runtime.runSync(InferenceUsage)
  readonly observeInference = piUsage(
    this.usage,
    (work) => modelCallback(this.runtime.runPromiseExit(work)),
    (attempt) =>
      reportInference(attempt, this.pin?.parentObject ?? this.ctx.id.toString())
  )
  private parent(): DurableObjectStub<PersonalAgent> {
    if (!this.pin) throw new Error("Background group has no handoff")
    return this.env.AGENT.get(
      this.env.AGENT.idFromString(this.pin.parentObject)
    )
  }
  readonly models = createAgentModels(
    accountCredentials(async (provider) => {
      if (!this.pin) return undefined
      const value = await backgroundParentRpc(this.parent()).credential(
        this.pin.id,
        provider
      )
      return value ? nativeAccountToken(value) : undefined
    }),
    {
      start: (request) =>
        this.runtime.runSync(
          Effect.flatMap(PiModelStreams, (streams) => streams.start(request))
        ),
      botId: () => this.pin?.parentObject ?? this.ctx.id.toString(),
      waitUntil: (work) => this.ctx.waitUntil(work),
      catalog: () => accountRpc(this.parent()).catalog(),
      contextWindow: (model) =>
        this.pin?.route.model === model
          ? this.pin.route.contextWindow
          : undefined,
      beforeRequest: (id, signal) =>
        modelCallback(
          this.runtime.runPromiseExit(this.group.request(id), { signal })
        ),
      onAttempt: (model, thinking, purpose) => {
        if (!this.pin) throw new Error("Background group has no route")
        return this.observeInference(
          { ...this.pin.route, model, thinking },
          this.pin.turnId,
          purpose
        )
      },
    }
  )
  readonly harness = new PiHarness({
    coordinateStorage: this.db.coordinatePi,
    harness: async ({ storage, context, onWake }) => {
      const h = await Harness.open(
        storage,
        {
          models: this.models,
          registry: createRegistry(),
          settings: agentSettings(() => {
            if (!this.pin) return undefined
            return this.models.getModel("openai", this.pin.route.model)
          }),
          onWake,
          onReport: (error) => reportHarness(error, "background"),
        },
        context
      )
      this.pin = await readBackgroundHandoff(h, context)
      if (
        this.pin &&
        !this.ctx.id.equals(
          this.env.BACKGROUND.idFromName(
            backgroundObjectName(this.pin.parentObject, this.pin.id)
          )
        )
      )
        throw new Error(
          "Stored background handoff belongs to a different object"
        )
      return h
    },
  })
  readonly group: BackgroundTasks["Service"] =
    this.runtime.runSync(BackgroundTasks)
  readonly services = new BackgroundServices(this)
  readonly lifecycle = Lifecycle.install(this)
    .use(this.harness)
    .use(this.services)
  private startProgram(parentObject: string, id: number) {
    return Effect.gen({ self: this }, function* () {
      if (
        !/^[a-f0-9]{64}$/.test(parentObject) ||
        !Number.isSafeInteger(id) ||
        id < 1 ||
        !this.ctx.id.equals(
          this.env.BACKGROUND.idFromName(backgroundObjectName(parentObject, id))
        )
      )
        return yield* Effect.die(new Error("Invalid background owner"))
      const parent = this.env.AGENT.get(
        this.env.AGENT.idFromString(parentObject)
      )
      const handoff = Schema.decodeUnknownSync(BackgroundHandoff)(
        yield* backgroundNative(() => backgroundParentRpc(parent).handoff(id))
      )
      if (handoff.id !== id || handoff.parentObject !== parentObject)
        return yield* Effect.die(
          new Error("Background handoff belongs to a different object")
        )
      yield* this.group.initialize(handoff)
      this.pin = handoff
      return yield* this.group.advance()
    })
  }
  async invokeV1(raw: unknown): Promise<Schema.Json> {
    const exit = await this.runtime.runPromiseExit(
      Effect.suspend<typeof BackgroundResult.Type, DelegationFailure, never>(
        () => {
          const request = Schema.decodeUnknownSync(BackgroundRequest)(raw)
          switch (request._tag) {
            case "Start":
              return this.startProgram(request.parentObject, request.id)
            case "Read":
              return this.group.read()
            case "Stop":
              return this.group.stop().pipe(Effect.as(null))
            case "Control":
              return this.group.control(request.input)
            case "Transcript":
              return this.group.transcript(request.child, request.cursor)
          }
        }
      ).pipe(Effect.map(Schema.decodeUnknownSync(BackgroundResult)))
    )
    if (Exit.isFailure(exit) && BackgroundOutcome.isUnexpected(exit))
      reportHarness(exit.cause, "background")
    return backgroundReply(exit)
  }
  async start(parentObject: string, id: number): Promise<Group> {
    return this.runtime.runPromise(this.startProgram(parentObject, id))
  }
  async read(): Promise<Group> {
    return this.runtime.runPromise(this.group.read())
  }
  async stop(): Promise<void> {
    await this.runtime.runPromise(this.group.stop())
  }
  async control(raw: unknown): Promise<BackgroundControlResult> {
    return this.runtime.runPromise(
      this.group.control(raw).pipe(
        preserveFatal,
        Effect.match({
          onSuccess: (result) => ({ ok: true as const, ...result }),
          onFailure: (error) => ({
            ok: false as const,
            code: error.code,
            message: error.message,
          }),
        })
      )
    )
  }
  async transcript(child: number, cursor?: string): Promise<Transcript> {
    return this.runtime.runPromise(this.group.transcript(child, cursor))
  }
}
