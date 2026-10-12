import "../observability/lifecycle"
import { reportInference, reportHarness } from "../observability/events"
import { DurableObject } from "cloudflare:workers"
import { Lifecycle } from "agents/lifecycle"
import { PiHarness } from "agents/harness/pi"
import { Harness, createRegistry } from "@earendil-works/pi-durable"
import { Effect, Schema } from "effect"
import type { PersonalAgent } from "../agent/worker"
import {
  Control,
  type Group,
  type Transcript,
  type DelegationFailure,
} from "./contracts"
import type { AgentEnv } from "../../alchemy.run"
import { accountCredentials, createAgentModels } from "../agent/models"
import { agentSettings } from "../agent/compaction"
import { InferenceUsage } from "../inference/usage"
import type { Sqlite } from "../storage/sqlite"
import { BackgroundHandoff, backgroundObjectName } from "./background"
import {
  piBackgroundGroup,
  readBackgroundHandoff,
} from "./adapters/background-pi"

export type BackgroundControlResult =
  | { ok: true; accepted: boolean }
  | { ok: false; code: DelegationFailure["code"]; message: string }

export interface BackgroundGroupRPC extends Rpc.DurableObjectBranded {
  start: (parentObject: string, id: number) => Promise<Group>
  read: () => Promise<Group>
  stop: () => Promise<void>
  control: (raw: unknown) => Promise<BackgroundControlResult>
  transcript: (child: number, cursor?: string) => Promise<Transcript>
}

/** Binding-only group runtime. No HTTP route, shared storage or independent refresh owner. */
export class BackgroundGroup
  extends DurableObject<AgentEnv>
  implements BackgroundGroupRPC
{
  private pin?: BackgroundHandoff
  readonly db: Sqlite = {
    all: <T>(query: string, ...bindings: (string | number | null)[]) =>
      this.ctx.storage.sql.exec(query, ...bindings).toArray() as T[],
    run: (query, ...bindings) => {
      this.ctx.storage.sql.exec(query, ...bindings)
    },
    transaction: (body) => this.ctx.storage.transactionSync(body),
  }
  readonly usage = new InferenceUsage(this.db, reportInference)
  private parent(): DurableObjectStub<PersonalAgent> {
    if (!this.pin) throw new Error("Background group has no handoff")
    return this.env.AGENT.get(
      this.env.AGENT.idFromString(this.pin.parentObject)
    )
  }
  readonly models = createAgentModels(
    accountCredentials(async (provider) => {
      if (!this.pin) return undefined
      return this.parent().backgroundCredential(this.pin.id, provider)
    }),
    {
      catalog: () => this.parent().accountModelCatalog(),
      contextWindow: (model) =>
        this.pin?.route.model === model
          ? this.pin.route.contextWindow
          : undefined,
      beforeRequest: async (id, signal) => {
        if (
          !this.pin ||
          !(await this.parent().backgroundAuthorized(this.pin.id))
        )
          throw new Error("This background group has stopped.")
        signal?.throwIfAborted()
        await Effect.runPromise(this.group.request(id), { signal })
      },
      onAttempt: (model, thinking, purpose) => {
        if (!this.pin) throw new Error("Background group has no route")
        return this.usage.start(
          { ...this.pin.route, model, thinking },
          this.pin.turnId,
          purpose
        )
      },
    }
  )
  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      const h = await Harness.open(
        storage,
        {
          models: this.models,
          registry: createRegistry(),
          settings: agentSettings(() => {
            if (!this.pin) return undefined
            return this.models.getModel("openai", this.pin.route.model)
          }),
          onReport: (error) => reportHarness(error, "background"),
        },
        context
      )
      // The stock bridge resumes only after this factory returns.
      this.pin = await readBackgroundHandoff(h)
      return h
    },
  })
  readonly group = piBackgroundGroup(() => this.harness.pi(), {
    submit: (child, text, operationId, steer) =>
      this.harness
        .session(String(child))
        .submit(text, { operationId, whenBusy: steer ? "steer" : "followUp" }),
    abort: (child) => this.harness.session(String(child)).abort(),
  })
  readonly lifecycle = Lifecycle.install(this).use(this.harness)
  async start(parentObject: string, id: number): Promise<Group> {
    if (
      !/^[a-f0-9]{64}$/.test(parentObject) ||
      !Number.isSafeInteger(id) ||
      id < 1 ||
      !this.ctx.id.equals(
        this.env.BACKGROUND.idFromName(backgroundObjectName(parentObject, id))
      )
    )
      throw new Error("Invalid background owner")
    const parent = this.env.AGENT.get(this.env.AGENT.idFromString(parentObject))
    const handoff = Schema.decodeUnknownSync(BackgroundHandoff)(
      await parent.backgroundHandoff(id)
    )
    await Effect.runPromise(this.group.initialize(handoff))
    this.pin = handoff
    if (!(await parent.backgroundAuthorized(id)))
      await Effect.runPromise(this.group.stop())
    return Effect.runPromise(this.group.advance())
  }
  async read(): Promise<Group> {
    return Effect.runPromise(this.group.read())
  }
  async stop(): Promise<void> {
    await Effect.runPromise(this.group.stop())
  }
  async control(raw: unknown): Promise<BackgroundControlResult> {
    const input = Schema.decodeUnknownSync(Control)(raw)
    await this.harness.pi()
    if (!this.pin || input.groupId !== this.pin.id)
      throw new Error("Invalid group")
    if (
      !(await this.parent().backgroundAuthorized(input.groupId)) &&
      (await Effect.runPromise(this.group.read())).status === "working"
    )
      await Effect.runPromise(this.group.stop())
    return Effect.runPromise(
      this.group.control(input).pipe(
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
    return Effect.runPromise(this.group.transcript(child, cursor))
  }
}
