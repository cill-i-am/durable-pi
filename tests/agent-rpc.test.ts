import { Cause, Effect, Exit, Layer, ManagedRuntime, Schema } from "effect"
import { afterEach, expect, it, vi } from "vitest"

import { PersonalAgent } from "../src/agent/worker"
import { BotConfigurationStore } from "../src/agents/adapters/configuration"
import {
  AgentOutcome,
  agentRpc,
  agentRpcNative,
} from "../src/agents/adapters/rpc"
import { agentRuntimeReader } from "../src/agents/adapters/statuses"
import { synchronizeTerminalAuthority } from "../src/agents/adapters/synchronization"
import {
  configureAgent,
  type TerminalAuthorityProjection,
} from "../src/agents/application"
import {
  BotConfiguration,
  configurationApplication,
} from "../src/agents/configuration"
import {
  AgentId,
  AgentStorageError,
  AgentNotFound,
  AgentSynchronizationError,
  AgentRuntimeUnavailable,
  homeAgentId,
  type AgentProfile,
} from "../src/agents/domain"
import { failure as communicationFailure } from "../src/communication/contracts"
import {
  accountConnectionRpc,
  AccountConnectionOutcome,
  accountNative,
} from "../src/inference/adapters/account-rpc"
import { CredentialStorageError } from "../src/inference/credentials"
import { database } from "./database"

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
  env: {},
  tracing: undefined,
}))
vi.mock("agents/lifecycle", () => ({
  Lifecycle: class {},
  LifecycleCapability: class {},
}))
vi.mock("agents/harness/pi", () => ({ PiHarness: class {} }))
vi.mock("../src/observability/events", () => ({
  reportHarness: vi.fn(),
  reportInference: vi.fn(),
  reportRecovery: vi.fn(),
  reportService: vi.fn(),
}))
const runtimes: ManagedRuntime.ManagedRuntime<never, never>[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
const profile: AgentProfile = {
  id: homeAgentId,
  name: "Fixture",
  instructions: "Synthetic instructions.",
  status: "active",
  revision: 1,
  createdAt: "2026-10-15T00:00:00Z",
  updatedAt: "2026-10-15T00:00:00Z",
}
const tags = <T, TError>(exit: Exit.Exit<T, TError>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.map((reason) => reason._tag) : []
function fixture() {
  const runtime = ManagedRuntime.make(Layer.empty)
  runtimes.push(runtime)
  const store = new BotConfigurationStore(database())
  const configuration = Effect.runSync(
    BotConfiguration.pipe(Effect.provide(configurationApplication(store)))
  )
  const host: PersonalAgent = Object.create(PersonalAgent.prototype)
  const projections: TerminalAuthorityProjection[] = []
  const sync = vi.fn<
    (
      projection: TerminalAuthorityProjection
    ) => Effect.Effect<void, AgentSynchronizationError>
  >((projection) =>
    Effect.sync(() => {
      projections.push(projection)
    })
  )
  const bind = vi.fn(() => Effect.void)
  const lookup = vi.fn(() => host)
  const list = vi.fn(() =>
    Effect.succeed([{ providerId: "openai", type: "oauth" }])
  )
  const catalog = {
    list: vi.fn(() => Effect.succeed([profile])),
    requireActive: vi.fn((id: string) =>
      id === profile.id
        ? Effect.succeed(profile)
        : Effect.fail(new AgentNotFound())
    ),
  }
  const waitUntil = vi.fn<(work: Promise<unknown>) => void>()
  Object.assign(host, {
    actorRuntime: runtime,
    configurationService: configuration,
    catalog,
    credentialService: { list },
    communication: { repository: { bindIdentity: bind } },
    env: { AGENT: { idFromName: (name: string) => name, getByName: lookup } },
    ctx: { id: { equals: (name: string) => name === "account" }, waitUntil },
    runtimeStatusProgram: () =>
      Effect.succeed({ state: "ready", turnId: null }),
    synchronizeConfiguration: configureAgent(configuration, {
      invalidateApps: () => Effect.void,
      syncTerminal: sync,
      wakeBrowser: () => Effect.void,
      extractionPending: () => Effect.succeed(false),
      wakeExtraction: () => Effect.void,
      appsPending: () => Effect.succeed(false),
      wakeApps: () => Effect.void,
      routinesPending: () => Effect.succeed(false),
      wakeRoutines: () => Effect.void,
    }),
  })
  return {
    host,
    store,
    catalog,
    projections,
    sync,
    bind,
    lookup,
    list,
    waitUntil,
    client: agentRpc(host),
  }
}
it("decodes real retained profile, status, configuration and account-connection handlers", async () => {
  const f = fixture()
  expect(await f.client.profiles()).toEqual([profile])
  expect(await f.client.profile(homeAgentId)).toEqual(profile)
  expect(await f.client.status()).toEqual({ state: "ready", turnId: null })
  expect(await f.client.configure("", profile, "account")).toBe(true)
  expect(f.bind).toHaveBeenCalledWith({ owner: "account", bot: homeAgentId })
  expect(Effect.runSync(f.store.read())).toMatchObject({
    owner: "",
    revision: 1,
    status: "active",
  })
  expect(await accountConnectionRpc(f.host).connected()).toBe(true)
  expect(f.waitUntil).toHaveBeenCalledTimes(5)
})
it("returns null for an inactive or missing profile", async () => {
  const f = fixture()
  Object.assign(f.catalog, {
    requireActive: () => Effect.fail(new AgentNotFound()),
  })
  expect(await f.client.profile(homeAgentId)).toBeNull()
})
it.each(["expected", "defect", "interrupt", "mixed"])(
  "preserves profile catalog %s outcomes without exposing private defects",
  async (kind) => {
    const f = fixture(),
      expected = new AgentStorageError()
    const reasons =
      kind === "expected"
        ? [Cause.makeFailReason(expected)]
        : kind === "defect"
          ? [Cause.makeDieReason("private catalog defect")]
          : kind === "interrupt"
            ? [Cause.makeInterruptReason(71)]
            : [
                Cause.makeFailReason(expected),
                Cause.makeDieReason("private compound defect"),
                Cause.makeInterruptReason(71),
              ]
    Object.assign(f.catalog, {
      list: () => Effect.failCause(Cause.fromReasons(reasons)),
    })
    const raw = await f.host.agentV1({ _tag: "Profiles" })
    expect(JSON.stringify(raw)).not.toContain("private")
    expect(tags(AgentOutcome.decode(raw))).toEqual(
      reasons.map((reason) => reason._tag)
    )
    const exit = await Effect.runPromiseExit(
      agentRpcNative(() => f.client.profiles())
    )
    expect(tags(exit)).toEqual(reasons.map((reason) => reason._tag))
  }
)
it("keeps a tagged status defect fatal instead of returning an unavailable status", async () => {
  const f = fixture()
  Object.assign(f.host, {
    runtimeStatusProgram: () => Effect.die(new AgentRuntimeUnavailable()),
  })
  expect(
    tags(await Effect.runPromiseExit(agentRpcNative(() => f.client.status())))
  ).toEqual(["Die"])
})
it.each(["status", "configuration", "mailbox identity"])(
  "retains every compound reason while translating %s failures",
  async (boundary) => {
    const f = fixture()
    const failed = <TError>(error: TError) =>
      Effect.failCause(
        Cause.fromReasons([
          Cause.makeFailReason(error),
          Cause.makeDieReason("private compound detail"),
          Cause.makeInterruptReason(71),
        ])
      )
    if (boundary === "status")
      Object.assign(f.host, {
        runtimeStatusProgram: () => failed(new AgentStorageError()),
      })
    else if (boundary === "configuration")
      Object.assign(f.host, {
        synchronizeConfiguration: () =>
          failed(
            new AgentSynchronizationError({ operation: "apply bot profile" })
          ),
      })
    else
      Object.assign(f.host.communication.repository, {
        bindIdentity: () =>
          failed(communicationFailure("storage", "Private identity failure")),
      })
    const work: () => Promise<unknown> =
      boundary === "status"
        ? () => f.client.status()
        : () => f.client.configure("", profile, "account")
    const exit = await Effect.runPromiseExit(agentRpcNative(work))
    expect(tags(exit)).toEqual(["Fail", "Die", "Interrupt"])
    expect(JSON.stringify(exit)).not.toContain("private compound detail")
  }
)
it("rejects mismatched profile identities and malformed acknowledgments", async () => {
  const f = fixture()
  Object.assign(f.catalog, {
    requireActive: () =>
      Effect.succeed({
        ...profile,
        id: Schema.decodeUnknownSync(AgentId)(crypto.randomUUID()),
      }),
  })
  expect(
    tags(
      await Effect.runPromiseExit(
        agentRpcNative(() => f.client.profile(homeAgentId))
      )
    )
  ).toEqual(["Die"])
  const bad = agentRpc({
    agentV1: async () => AgentOutcome.encode(Exit.succeed(null)),
  })
  expect(
    tags(
      await Effect.runPromiseExit(
        agentRpcNative(() => bad.configure("", profile))
      )
    )
  ).toEqual(["Die"])
})
it("reconciles a failed profile projection on explicit retry without another revision", async () => {
  const f = fixture(),
    previous = vi.fn(async () => {})
  Object.assign(f.host, { configureBot: previous })
  f.sync.mockReturnValueOnce(
    Effect.fail(
      new AgentSynchronizationError({ operation: "project terminal" })
    )
  )
  const first = await Effect.runPromiseExit(
    agentRpcNative(() => f.client.configure("", profile))
  )
  expect(tags(first)).toEqual(["Fail"])
  expect(previous).not.toHaveBeenCalled()
  expect(Effect.runSync(f.store.read())?.revision).toBe(1)
  expect(await f.client.configure("", profile)).toBe(true)
  expect(Effect.runSync(f.store.read())?.revision).toBe(1)
})
it("does not restore an archived profile when an older active projection is repeated", async () => {
  const f = fixture()
  await f.client.configure("", { ...profile, revision: 2, status: "archived" })
  await f.client.configure("", profile)
  expect(Effect.runSync(f.store.read())).toMatchObject({
    revision: 2,
    status: "archived",
  })
  expect(f.projections.at(-1)).toMatchObject({ revision: 2, active: false })
})
it("rejects foreign mailbox identities before reading profiles or changing configuration", async () => {
  const f = fixture()
  const exit = await Effect.runPromiseExit(
    agentRpcNative(() => f.client.prepare("other-owner", homeAgentId))
  )
  expect(tags(exit)).toEqual(["Fail"])
  expect(f.lookup).not.toHaveBeenCalled()
  expect(f.bind).not.toHaveBeenCalled()
  expect(Effect.runSync(f.store.read())).toBeUndefined()
})
it("prepares the same owned mailbox and profile through composed capabilities", async () => {
  const f = fixture()
  expect(await f.client.prepare("account", homeAgentId)).toBe(true)
  expect(Effect.runSync(f.store.read())).toMatchObject({
    owner: "",
    revision: 1,
  })
  expect(f.bind).toHaveBeenCalledWith({ owner: "account", bot: homeAgentId })
})
it("resolves an account's own connection locally even when its configuration names itself", async () => {
  const f = fixture()
  Effect.runSync(f.store.configure("account", profile))
  expect(await f.host.modelConnected()).toBe(true)
  expect(f.lookup).toHaveBeenCalledOnce()
  expect(f.list).toHaveBeenCalledOnce()
})
it("falls back to validated legacy reads and idempotent configuration when the new native method is unavailable", async () => {
  const previous = vi.fn(async () => profile),
    configure = vi.fn(async () => {})
  const client = agentRpc({
    agentV1: async () => {
      throw new Error("Method unavailable")
    },
    agentProfile: previous,
    configureBot: configure,
  })
  expect(await client.profile(homeAgentId)).toEqual(profile)
  expect(await client.configure("", profile, "account")).toBe(true)
  expect(configure).toHaveBeenCalledWith("", profile, "account")
})
it.each(["expected", "defect", "malformed"])(
  "never falls back after a modern %s reply",
  async (kind) => {
    const previous = vi.fn(async () => profile)
    const raw =
      kind === "malformed"
        ? { invalid: true }
        : AgentOutcome.encode(
            kind === "expected"
              ? Exit.fail(new AgentStorageError())
              : Exit.die("private")
          )
    const client = agentRpc({
      agentV1: async () => raw,
      agentProfile: previous,
    })
    expect(
      tags(
        await Effect.runPromiseExit(
          agentRpcNative(() => client.profile(homeAgentId))
        )
      )
    ).toEqual([kind === "expected" ? "Fail" : "Die"])
    expect(previous).not.toHaveBeenCalled()
  }
)
it("validates a legacy connection reply without exposing a model credential", async () => {
  expect(
    await accountConnectionRpc({ modelConnected: async () => true }).connected()
  ).toBe(true)
  const invalid = accountConnectionRpc({
    modelConnected: async () => ({ access: "private token" }),
  })
  expect(
    tags(await Effect.runPromiseExit(accountNative(() => invalid.connected())))
  ).toEqual(["Die"])
})
it("preserves compound account-connection causes across the native codec", async () => {
  const f = fixture(),
    expected = new CredentialStorageError()
  Object.assign(f.host, {
    credentialService: {
      list: () =>
        Effect.failCause(
          Cause.fromReasons([
            Cause.makeFailReason(expected),
            Cause.makeDieReason("private connection detail"),
            Cause.makeInterruptReason(71),
          ])
        ),
    },
  })
  const raw = await f.host.modelConnectionV1()
  expect(JSON.stringify(raw)).not.toContain("private")
  expect(tags(AccountConnectionOutcome.decode(raw))).toEqual([
    "Fail",
    "Die",
    "Interrupt",
  ])
})
it("keeps a late status decoding defect visible to its Worker after display cancellation", async () => {
  const entered = deferred<void>(),
    reply = deferred<unknown>(),
    owned: Promise<void>[] = [],
    controller = new AbortController()
  const reader = agentRuntimeReader(
    () => {
      entered.resolve()
      return reply.promise
    },
    (work) => {
      owned.push(work)
      void work.catch(() => {})
    }
  )
  const observed = Effect.runPromiseExit(reader(profile), {
    signal: controller.signal,
  })
  await entered.promise
  controller.abort()
  expect(tags(await observed)).toContain("Interrupt")
  reply.resolve({ state: "ready", turnId: 3 })
  const outcome = await Promise.allSettled(owned)
  expect(outcome[0]?.status).toBe("rejected")
})
it.each(["invalid", "defect"])(
  "joins a late %s status failure when native owner registration fails",
  async (kind) => {
    const entered = deferred<void>(),
      reply = deferred<unknown>(),
      controller = new AbortController(),
      registration = new Error("Native owner registration failed")
    let settled = false
    const read = agentRuntimeReader(
      () => {
        entered.resolve()
        return reply.promise
      },
      () => {
        throw registration
      }
    )
    const running = Effect.runPromiseExit(read(profile), {
      signal: controller.signal,
    }).then((exit) => {
      settled = true
      return exit
    })
    await entered.promise
    controller.abort()
    expect(settled).toBe(false)
    if (kind === "invalid") reply.resolve({ state: "invalid", turnId: null })
    else reply.reject(Cause.die("Late status defect"))
    const exit = await running
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const defects = exit.cause.reasons.filter(
        (reason) => reason._tag === "Die"
      )
      expect(defects).toHaveLength(2)
      expect(defects.some((reason) => reason.defect === registration)).toBe(
        true
      )
    }
    // Give the host's unhandled-rejection check a turn as well as inspecting Exit.
    await new Promise<void>((done) => setImmediate(done))
  }
)
it("joins cleanup of a Terminal response acquired after profile synchronization was interrupted", async () => {
  const entered = deferred<void>(),
    reply = deferred<Response>(),
    cancelling = deferred<void>(),
    closing = deferred<void>(),
    controller = new AbortController()
  let settled = false
  const work = Effect.runPromiseExit(
    synchronizeTerminalAuthority(
      {
        fetch: () => {
          entered.resolve()
          return reply.promise
        },
      },
      "actor",
      { revision: 1, active: true }
    ),
    { signal: controller.signal }
  ).then((exit) => {
    settled = true
    return exit
  })
  await entered.promise
  controller.abort()
  reply.resolve(
    new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelling.resolve()
          return closing.promise
        },
      })
    )
  )
  await cancelling.promise
  expect(settled).toBe(false)
  const cleanup = new Error("private terminal response cleanup")
  closing.reject(cleanup)
  const exit = await work
  expect(tags(exit)).toContain("Interrupt")
  expect(
    Exit.isFailure(exit) &&
      exit.cause.reasons.filter((reason) => reason._tag === "Die")
  ).toEqual([expect.objectContaining({ _tag: "Die", defect: cleanup })])
})

it("exposes only active contact identity and name, without private instructions", async () => {
  const f = fixture()
  const archived = {
    ...profile,
    status: "archived" as const,
    id: Schema.decodeUnknownSync(AgentId)(crypto.randomUUID()),
  }
  Object.assign(f.catalog, { list: () => Effect.succeed([profile, archived]) })
  expect(await f.client.contacts()).toEqual([
    { id: homeAgentId, name: profile.name },
  ])
  expect(JSON.stringify(await f.client.contacts())).not.toContain(
    profile.instructions
  )
})
it("rejects invalid modern requests before profile or identity mutation", async () => {
  const f = fixture()
  for (const raw of [
    { _tag: "Unknown" },
    { _tag: "Profile", id: "invalid" },
    { _tag: "Configure", owner: "", profile: { ...profile, revision: -1 } },
  ]) {
    expect(tags(AgentOutcome.decode(await f.host.agentV1(raw)))).toEqual([
      "Die",
    ])
  }
  expect(f.bind).not.toHaveBeenCalled()
  expect(Effect.runSync(f.store.read())).toBeUndefined()
})
it("reconciles a lost modern configuration acknowledgement through the idempotent legacy projection", async () => {
  const f = fixture(),
    previous = vi.fn((owner: string, value: AgentProfile) =>
      f.host.configureBot(owner, value)
    )
  const client = agentRpc({
    agentV1: async (request) => {
      await f.host.agentV1(request)
      throw new Error("Acknowledgement lost")
    },
    configureBot: previous,
  })
  expect(await client.configure("", profile)).toBe(true)
  expect(previous).toHaveBeenCalledOnce()
  expect(Effect.runSync(f.store.read())?.revision).toBe(1)
  expect(f.projections).toHaveLength(2)
})
