import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai"
import {
  Harness,
  createRegistry,
  type ConversationId,
} from "@earendil-works/pi-durable"
import { PiHarness } from "agents/harness/pi"
import { Lifecycle } from "agents/lifecycle"
import { DurableObject } from "cloudflare:workers"
import { Effect, Scope } from "effect"

import {
  CoordinationRunner,
  observeCoordinationSchedule,
} from "../../src/coordination/adapters/lifecycle"
import { CoordinationStore } from "../../src/coordination/adapters/sqlite"
import { fail, type Agent } from "../../src/coordination/contracts"
import { AgentCoordination } from "../../src/coordination/service"
import { piDelegationLedger } from "../../src/delegation/adapters/pi"
import { DelegationFailure } from "../../src/delegation/contracts"
import { requestId, type SavedGroup } from "../../src/delegation/domain"
import { makeDelegations } from "../../src/delegation/service"
import { resolveRoute } from "../../src/inference/policy"
import { attributedText } from "../../src/messages/identity"
import { nativeDatabase } from "./database"

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
type Probe = {
  parent: number
  child: number
  message: string
  lease: number
  steps: number
  calls: number
  restores: number
  stopped: number
  trace: string
}
class ProbeRunner<E> extends CoordinationRunner<E> {
  inspect() {
    return this.lifecycle.jobs.get("agent-coordination:pump")
  }
}

/** Real Lifecycle/SQLite/Pi composition. Authority and model responses are
 * synthetic; the fixture makes no claim about full PersonalAgent authorization. */
export class CoordinationProbe extends DurableObject<Record<string, never>> {
  readonly scope = Scope.makeUnsafe()
  readonly db = nativeDatabase(this.ctx.storage, this.scope)
  readonly registry = createRegistry()
  private manual = false
  private bypassOwner = false
  private loseWake = false
  private lease?: number
  private heldRequest?: string
  private readonly entered = deferred()
  private readonly release = deferred()
  private readonly revoked = deferred()
  private pumping?: Promise<unknown>
  private stopping?: Promise<unknown>
  readonly store = new CoordinationStore(this.db)
  readonly harness = new PiHarness({
    coordinateStorage: this.db.coordinatePi,
    harness: ({ storage, context: nativeContext }) => {
      const models = createModels()
      const provider = fauxProvider({
        provider: "openai",
        models: [
          {
            id: "test",
            reasoning: false,
            contextWindow: 32000,
            maxTokens: 2000,
          },
        ],
        tokensPerSecond: 100000,
      })
      models.setProvider(provider.provider)
      provider.setResponses(
        Array.from({ length: 20 }, () => async () => {
          this.db.run("UPDATE coordination_probe SET calls=calls+1")
          return fauxAssistantMessage("Private synthetic answer")
        })
      )
      return Harness.open(
        storage,
        {
          models,
          registry: this.registry,
          settings: {
            retry: { enabled: false },
            compaction: { enabled: false },
          },
        },
        nativeContext
      )
    },
  })
  private async observed() {
    const harness = await this.harness.pi()
    return new Proxy(harness, {
      get: (target, member) => {
        if (member === "conversation")
          return async (...args: Parameters<Harness["conversation"]>) => {
            const child = await target.conversation(...args)
            if (!child) return child
            return new Proxy(child, {
              get: (native, operation) => {
                if (operation === "submit")
                  return async (...input: Parameters<typeof child.submit>) => {
                    const id = input[0].requestId
                    if (id === this.heldRequest) {
                      this.trace("submit-held")
                      this.entered.resolve()
                      await this.release.promise
                    }
                    const receipt = await native.submit(...input)
                    this.trace(`admitted:${id}`)
                    return receipt
                  }
                if (operation === "abort")
                  return async (...input: Parameters<typeof child.abort>) => {
                    this.trace("abort-started")
                    await native.abort(...input)
                    this.trace("abort-acknowledged")
                  }
                const value = Reflect.get(native, operation)
                return typeof value === "function" ? value.bind(native) : value
              },
            })
          }
        const value = Reflect.get(target, member)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
  }
  readonly ledger = piDelegationLedger(
    () => this.observed(),
    () => this.registry.snapshot().extension("reader")!,
    () => []
  )
  private schedule<A>(operation: string, work: () => Promise<A>) {
    return observeCoordinationSchedule(operation, work).pipe(
      Effect.mapError(
        (error) =>
          new DelegationFailure({ code: "unavailable", message: error.message })
      )
    )
  }
  readonly delegations = makeDelegations(
    {
      ...this.ledger,
      atomic: (body) =>
        this.ledger.atomic(body).pipe(
          Effect.tap(() =>
            this.ledger.catalog().pipe(
              Effect.flatMap((ids) =>
                ids.length
                  ? this.ledger.group(ids[0]!).pipe(
                      Effect.tap((group) =>
                        Effect.sync(() => {
                          if (group.children[0]?.stopped) this.revoked.resolve()
                        })
                      ),
                      Effect.asVoid
                    )
                  : Effect.void
              )
            )
          )
        ),
    },
    { current: () => true, cancelled: () => false },
    undefined,
    {
      arm: () => this.schedule("arm native coordination", () => this.arm()),
      wake: () =>
        this.schedule("wake native coordination", () => this.runner.wake()),
    }
  )
  readonly messages = new AgentCoordination(this.store, {
    bot: "native-coordination-probe",
    enabled: () => Effect.succeed(true),
    source: (id) =>
      this.agents().pipe(
        Effect.map((agents) => agents.find((agent) => agent.nativeId === id))
      ),
    agents: () => this.agents(),
    sessions: () => Effect.succeed([]),
    latest: () => Effect.succeed(null),
    prearm: () =>
      observeCoordinationSchedule("arm native message", () => this.arm()),
    wake: () =>
      this.loseWake
        ? Effect.fail(fail("unavailable", "Injected lost postcommit wake"))
        : observeCoordinationSchedule("wake native message", () =>
            this.runner.wake()
          ),
    deliver: (message, target) => {
      // Negative-control fault injection: recreate the removed direct native
      // route while leaving real child Stop ownership and storage untouched.
      if (this.bypassOwner)
        return Effect.promise(async () => {
          const child = await (
            await this.observed()
          ).conversation(target.nativeId as ConversationId, context)
          if (!child) throw new Error("Missing native child")
          await child.submit(
            {
              type: "input",
              content: message.text,
              requestId: message.id,
              whenBusy: "steer",
            },
            context
          )
        })
      return this.delegations
        .deliverMessage(
          target.nativeId,
          attributedText(
            JSON.stringify({
              messageId: message.id,
              from: message.from,
              text: message.text,
            }),
            message.provenance
          ),
          message.id
        )
        .pipe(
          Effect.mapError((error) =>
            fail(
              error.code === "cancelled" ? "closed" : "unavailable",
              error.message
            )
          )
        )
    },
  })
  readonly runner = new ProbeRunner({
    run: Effect.runPromise,
    step: async () => {
      this.db.run("UPDATE coordination_probe SET steps=steps+1")
      if (this.manual) return undefined
      for (const id of await Effect.runPromise(this.ledger.catalog())) {
        const group = await Effect.runPromise(this.ledger.group(id))
        await Effect.runPromise(this.delegations.reconcile(group.turnId))
      }
      const message = await Effect.runPromise(this.messages.pump())
      const group = await Effect.runPromise(this.delegations.nextWake())
      const next = Math.min(message ?? Infinity, group ?? Infinity)
      return Number.isFinite(next) ? next : undefined
    },
    restore: () =>
      Effect.gen({ self: this }, function* () {
        this.db.run("UPDATE coordination_probe SET restores=restores+1")
        yield* this.delegations.restore()
        yield* this.messages.restore()
      }),
    exhaust: (current) =>
      this.store
        .exhaust(current)
        .pipe(Effect.andThen(this.delegations.exhaustRecovery(current))),
    nextWake: () => this.store.nextWake(),
  })
  readonly lifecycle: Lifecycle = new Lifecycle(this)
    .use(this.harness)
    .use(this.runner)
  constructor(ctx: DurableObjectState, env: Record<string, never>) {
    super(ctx, env)
    this.registry.install({ name: "reader" })
    this.db.run(
      "CREATE TABLE IF NOT EXISTS coordination_probe(parent INTEGER,child INTEGER,message TEXT,lease INTEGER,steps INTEGER,calls INTEGER,restores INTEGER,stopped INTEGER,trace TEXT)"
    )
    if (!this.db.all("SELECT * FROM coordination_probe").length)
      this.db.run(
        "INSERT INTO coordination_probe VALUES(0,0,'',0,0,0,0,0,'[]')"
      )
  }
  alarm() {
    return this.lifecycle.alarm()
  }
  async onStart() {
    // Match production composition: cold restoration finishes before any
    // request can start a warm message/child dispatch owner.
    await this.runner.reconcile()
  }
  private metrics() {
    return this.db.all<Probe>("SELECT * FROM coordination_probe")[0]!
  }
  private trace(event: string) {
    const events = JSON.parse(this.metrics().trace) as string[]
    this.db.run(
      "UPDATE coordination_probe SET trace=?",
      JSON.stringify([...events, event])
    )
  }
  private arm() {
    return this.lease === undefined
      ? this.runner.armDiscovery()
      : Promise.resolve(this.lease)
  }
  private agents() {
    return this.ledger
      .catalog()
      .pipe(
        Effect.flatMap((ids) =>
          ids.length
            ? this.ledger.group(ids[0]!).pipe(
                Effect.map((group): Agent[] => [
                  {
                    address: { sessionId: "source", agentId: "main" },
                    name: "Main",
                    role: "main",
                    nativeId: group.conversationId,
                    status: "idle",
                  },
                  {
                    address: {
                      sessionId: "source",
                      agentId: String(group.children[0]!.id),
                    },
                    name: "Child",
                    role: "child",
                    nativeId: group.children[0]!.id,
                    status: group.children[0]!.stopped ? "stopped" : "idle",
                    deadline: group.deadline,
                  },
                ])
              )
            : Effect.succeed([])
        )
      )
      .pipe(Effect.mapError((error) => fail("unavailable", error.message)))
  }
  private async seed() {
    if (this.metrics().child) return
    const root = await (await this.harness.pi()).root(context)
    const source = {
      detached: true,
      taskId: 7,
      turnId: "source",
      conversationId: Number(root.id),
      route: resolveRoute("conversation", { model: "test", thinking: "off" }),
      memory: "Private fixture",
    }
    const task = { name: "Child", task: "Prepare a private draft", tools: [] }
    const group = await Effect.runPromise(
      this.ledger.atomic((tx) =>
        Effect.gen(function* () {
          const childId = yield* tx.createChild(source, task)
          const saved: SavedGroup = {
            ...source,
            id: source.taskId,
            input: { objective: "Private draft", tasks: [task] },
            createdAt: Date.now(),
            deadline: Date.now() + 600000,
            revision: 0,
            closed: false,
            children: [{ ...task, id: childId, requests: 0, stopped: false }],
            controls: [],
          }
          ;(yield* tx.group(saved.id)).value = saved
          ;(yield* tx.parent(saved.turnId)).group = saved.id
          ;(yield* tx.catalog()).ids.push(saved.id)
          return saved
        })
      )
    )
    this.db.run(
      "UPDATE coordination_probe SET parent=?,child=?",
      group.conversationId,
      group.children[0]!.id
    )
  }
  private async send() {
    const data = this.metrics()
    const result = await Effect.runPromise(
      Effect.result(
        this.messages.send(data.parent, "native-addressed-message", {
          to: { sessionId: "source", agentId: String(data.child) },
          text: "Private peer followup",
        })
      )
    )
    if (result._tag === "Failure" && !this.loseWake) throw result.failure
    const saved = await Effect.runPromise(
      this.store.operation("native-addressed-message")
    )
    if (!saved) throw new Error("Message was not accepted")
    this.db.run("UPDATE coordination_probe SET message=?", saved.id)
    return saved.id
  }
  private async stopChild() {
    await Effect.runPromise(
      this.delegations.control({
        groupId: 7,
        childId: this.metrics().child,
        operationId: "00000000-0000-4000-8000-000000000001",
        action: { type: "stop" },
      })
    )
    this.db.run("UPDATE coordination_probe SET stopped=1")
    this.trace("stop-returned")
  }
  private async snapshot() {
    const data = this.metrics()
    const group = data.child
      ? await Effect.runPromise(this.ledger.group(7))
      : undefined
    const storage = await this.harness.storage()
    const initial = group
      ? await storage.submissionByRequest(
          data.child as ConversationId,
          requestId(group, data.child),
          context
        )
      : undefined
    const message = data.message
      ? await storage.submissionByRequest(
          data.child as ConversationId,
          data.message,
          context
        )
      : undefined
    return {
      ...data,
      trace: JSON.parse(data.trace) as string[],
      group,
      initial,
      message,
      row: data.message
        ? await Effect.runPromise(this.store.get(data.message))
        : undefined,
      job: this.runner.inspect(),
      wake: await this.ctx.storage.getAlarm(),
    }
  }
  async fetch(request: Request) {
    await this.lifecycle.start()
    const path = new URL(request.url).pathname
    if (path === "/arm-empty") {
      this.lease = await this.runner.armDiscovery()
      this.db.run("UPDATE coordination_probe SET lease=?", this.lease)
    }
    if (path === "/commit") {
      this.manual = true
      this.loseWake = true
      this.lease = this.metrics().lease
      await this.seed()
      await this.send()
    }
    if (path === "/held" || path === "/stop-first") {
      this.manual = true
      this.bypassOwner = new URL(request.url).searchParams.has("bypass-owner")
      await this.seed()
      await Effect.runPromise(this.delegations.reconcile("source"))
      const group = await Effect.runPromise(this.ledger.group(7))
      await Effect.runPromise(
        this.ledger.waitRequest(
          this.metrics().child,
          requestId(group, this.metrics().child)
        )
      )
      this.heldRequest = await this.send()
      if (path === "/held") {
        this.pumping = Effect.runPromise(this.messages.pump())
        this.ctx.waitUntil(this.pumping)
        await this.entered.promise
      } else {
        await this.stopChild()
        await Effect.runPromise(this.messages.pump())
      }
    }
    if (path === "/stop") {
      this.stopping = this.stopChild()
      this.ctx.waitUntil(this.stopping)
      await this.revoked.promise
    }
    if (path === "/release") {
      this.release.resolve()
      await Promise.all([this.pumping, this.stopping])
    }
    return Response.json(await this.snapshot())
  }
}
export default {
  fetch(request: Request, env: { PROBES: DurableObjectNamespace }) {
    const url = new URL(request.url)
    if (url.pathname === "/health") return new Response("ok")
    return env.PROBES.getByName(
      url.searchParams.get("name") ?? "retained"
    ).fetch(request)
  },
}
