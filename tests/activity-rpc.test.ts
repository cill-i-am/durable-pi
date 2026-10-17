import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect"
import { afterEach, expect, it, vi } from "vitest"

import {
  activityDirectory,
  ActivityOutcome,
  activityReadRpc,
  activityRpc,
} from "../src/activity/adapters/rpc"
import {
  type ActivityConversation,
  ActivitySnapshot,
} from "../src/activity/contracts"
import {
  ActivityStorageError,
  ActivityUnavailable,
} from "../src/activity/records"
import { activitySource } from "../src/activity/service"
import { PersonalAgent } from "../src/agent/worker"
import { AgentOutcome } from "../src/agents/adapters/rpc"
import { AgentStorageError, homeAgentId } from "../src/agents/domain"
import { AccountConnectionOutcome } from "../src/inference/adapters/account-rpc"
import { CredentialStorageError } from "../src/inference/credentials"
import {
  webhookAuthorizationRpc,
  WebhookAuthorizationOutcome,
} from "../src/webhooks/adapters/authorization-rpc"
import { WebhookStorageError } from "../src/webhooks/persistence"

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
const agent = { id: homeAgentId, name: "Home" },
  query = { filter: "all" as const, cursor: null },
  id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  key = `rpwh_${"a".repeat(64)}`
const record: ActivityConversation = {
  source: "user",
  id,
  text: "Saved request",
  answer: "Saved answer",
  status: "done",
  error: null,
  activity: [],
}
const tags = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.map((reason) => reason._tag) : []
function fixture() {
  const runtime = ManagedRuntime.make(Layer.empty)
  runtimes.push(runtime)
  const host: PersonalAgent = Object.create(PersonalAgent.prototype)
  const snapshot = vi.fn(
    (): Effect.Effect<
      ActivitySnapshot,
      ActivityStorageError | ActivityUnavailable
    > => Effect.succeed({ entries: [], issues: [] })
  )
  const conversation = vi.fn(
    (): Effect.Effect<
      ActivityConversation | null,
      ActivityStorageError | ActivityUnavailable
    > => Effect.succeed(record)
  )
  const authorized = vi.fn(
    (_id: string, _hash: string): Effect.Effect<boolean, WebhookStorageError> =>
      Effect.succeed(true)
  )
  const waitUntil = vi.fn<(work: Promise<unknown>) => void>()
  Object.assign(host, {
    actorRuntime: runtime,
    ctx: { waitUntil },
    activity: { snapshot, conversation },
    webhooks: { authorized },
  })
  return {
    host,
    snapshot,
    conversation,
    authorized,
    waitUntil,
    client: activityReadRpc(host),
  }
}
function failure<TError>(error: TError, mode: string) {
  return Cause.fromReasons<TError>(
    mode === "expected"
      ? [Cause.makeFailReason(error)]
      : mode === "defect"
        ? [Cause.makeDieReason("Private read defect")]
        : mode === "interrupt"
          ? [Cause.makeInterruptReason(73)]
          : [
              Cause.makeFailReason(error),
              Cause.makeDieReason("Private compound read defect"),
              Cause.makeInterruptReason(73),
            ]
  )
}
it("uses actual retained Activity handlers and pins their finite work", async () => {
  const f = fixture()
  expect(await f.client.snapshot(agent, query)).toEqual({
    entries: [],
    issues: [],
  })
  expect(await f.client.conversation(id, null)).toEqual(record)
  expect(f.snapshot).toHaveBeenCalledWith(agent, query)
  expect(f.conversation).toHaveBeenCalledWith(id, null)
  expect(f.waitUntil).toHaveBeenCalledTimes(2)
})
for (const boundary of ["snapshot", "conversation"] as const)
  it.each(["expected", "defect", "interrupt", "mixed"])(
    `preserves complete ${boundary} %s outcomes and redacts private causes`,
    async (mode) => {
      const f = fixture(),
        cause = failure(
          new ActivityStorageError({ cause: "Private database details" }),
          mode
        )
      f[boundary].mockImplementation(() => Effect.failCause(cause))
      const raw = await f.host.activityV1(
        boundary === "snapshot"
          ? { _tag: "Snapshot", agent, query }
          : { _tag: "Conversation", id, cursor: null }
      )
      expect(JSON.stringify(raw)).not.toContain("Private")
      expect(tags(ActivityOutcome.decode(raw))).toEqual(
        cause.reasons.map((reason) => reason._tag)
      )
    }
  )
it("retains the declared unavailable tag after prototype loss", async () => {
  const f = fixture(),
    error = new ActivityUnavailable({ cause: "Private source" })
  Object.setPrototypeOf(error, Error.prototype)
  f.snapshot.mockImplementation(() => Effect.fail(error))
  expect(
    tags(
      ActivityOutcome.decode(
        await f.host.activityV1({ _tag: "Snapshot", agent, query })
      )
    )
  ).toEqual(["Fail"])
})
it("rejects invalid Activity requests before reading", async () => {
  const f = fixture()
  for (const input of [
    { _tag: "Unknown" },
    { _tag: "Snapshot", agent, query: { filter: "invalid", cursor: null } },
    { _tag: "Conversation", id, cursor: { at: 1, key: "x" } },
  ])
    expect(
      tags(ActivityOutcome.decode(await f.host.activityV1(input)))
    ).toEqual(["Die"])
  expect(f.snapshot).not.toHaveBeenCalled()
  expect(f.conversation).not.toHaveBeenCalled()
})
it.each(["malformed", "expected", "defect"])(
  "does not fall back after a modern %s reply",
  async (mode) => {
    const previous = vi.fn(async () => ({ entries: [], issues: [] }))
    const raw =
      mode === "malformed"
        ? {}
        : ActivityOutcome.encode(
            mode === "expected"
              ? Exit.fail(new ActivityUnavailable({ cause: "Private source" }))
              : Exit.die("Private defect")
          )
    const client = activityReadRpc({
      activityV1: async () => raw,
      readActivity: previous,
    })
    const owned: Promise<void>[] = []
    const exit = await Effect.runPromiseExit(
      activityRpc(
        ActivitySnapshot,
        () => client.snapshot(agent, query),
        (work) => {
          owned.push(work)
          void work.catch(() => {})
        }
      )
    )
    expect(tags(exit)).toEqual([mode === "expected" ? "Fail" : "Die"])
    expect(previous).not.toHaveBeenCalled()
    await Promise.allSettled(owned)
  }
)
it("uses the previous read-only protocol after opaque missing-method rejection", async () => {
  const previous = vi.fn(async () => record)
  const client = activityReadRpc({
    activityV1: async () => {
      throw new Error("Method is unavailable")
    },
    activityConversation: previous,
  })
  expect(await client.conversation(id, null)).toEqual(record)
  expect(previous).toHaveBeenCalledWith(id, null)
})
it.each(["identity", "operation"])(
  "rejects a modern reply with the wrong %s",
  async (mode) => {
    const raw = ActivityOutcome.encode(
      Exit.succeed(
        mode === "identity"
          ? { ...record, id: crypto.randomUUID() }
          : { entries: [], issues: [] }
      )
    )
    await expect(
      activityReadRpc({ activityV1: async () => raw }).conversation(id, null)
    ).rejects.toSatisfy(
      (cause: unknown) => Cause.isCause(cause) && Cause.hasDies(cause)
    )
  }
)
it("validates malformed legacy data before returning it", async () => {
  await expect(
    activityReadRpc({
      readActivity: async () => ({ entries: "invalid", issues: [] }),
    }).snapshot(agent, query)
  ).rejects.toSatisfy(
    (cause: unknown) => Cause.isCause(cause) && Cause.hasDies(cause)
  )
})
it("uses actual webhook authorization without returning the bearer or hash", async () => {
  const f = fixture()
  expect(await webhookAuthorizationRpc(f.host).authorized(id, key)).toBe(true)
  expect(f.authorized).toHaveBeenCalledWith(
    id,
    expect.stringMatching(/^[a-f0-9]{64}$/)
  )
  expect(f.authorized.mock.calls[0]?.[1]).not.toBe(key)
  expect(await webhookAuthorizationRpc(f.host).authorized("invalid", key)).toBe(
    false
  )
  expect(f.authorized).toHaveBeenCalledOnce()
})
it.each(["expected", "defect", "interrupt", "mixed"])(
  "preserves webhook authorization %s outcomes without private storage details",
  async (mode) => {
    const f = fixture(),
      cause = failure(
        new WebhookStorageError({
          operation: "read",
          cause: "Private webhook storage",
        }),
        mode
      )
    f.authorized.mockImplementation(() => Effect.failCause(cause))
    const raw = await f.host.webhookAuthorizationV1({ id, key })
    expect(JSON.stringify(raw)).not.toContain("Private")
    expect(JSON.stringify(raw)).not.toContain(key)
    expect(tags(WebhookAuthorizationOutcome.decode(raw))).toEqual(
      cause.reasons.map((reason) => reason._tag)
    )
  }
)
it("does not retry a webhook authorization defect through the previous protocol", async () => {
  const previous = vi.fn(async () => true)
  await expect(
    webhookAuthorizationRpc({
      webhookAuthorizationV1: async () =>
        WebhookAuthorizationOutcome.encode(Exit.die("Private")),
      webhookAuthorized: previous,
    }).authorized(id, key)
  ).rejects.toSatisfy(
    (cause: unknown) => Cause.isCause(cause) && Cause.hasDies(cause)
  )
  expect(previous).not.toHaveBeenCalled()
})
it("preserves compound source failures while projecting the Activity error contract", async () => {
  const error = new Error("Private source failure")
  const cause = Cause.fromReasons([
    Cause.makeFailReason(error),
    Cause.makeDieReason("Private defect"),
    Cause.makeInterruptReason(73),
  ])
  const exit = await Effect.runPromiseExit(
    activitySource(Effect.failCause(cause))
  )
  expect(tags(exit)).toEqual(["Fail", "Die", "Interrupt"])
  expect(
    Exit.isFailure(exit) &&
      exit.cause.reasons[0]?._tag === "Fail" &&
      exit.cause.reasons[0].error
  ).toMatchObject({ _tag: "ActivityUnavailable", cause: error })
})
it.each(["contacts", "profile", "connected"])(
  "translates declared %s failures from another context into Activity availability",
  async (boundary) => {
    const directory = activityDirectory(
      "owner",
      {
        agentV1: async () =>
          AgentOutcome.encode(Exit.fail(new AgentStorageError())),
        modelConnectionV1: async () =>
          AccountConnectionOutcome.encode(
            Exit.fail(new CredentialStorageError())
          ),
      },
      () => ({}),
      (work) => {
        void work.catch(() => {})
      }
    )
    const work: Effect.Effect<unknown, ActivityUnavailable> =
      boundary === "contacts"
        ? directory.agents()
        : boundary === "profile"
          ? directory.find(homeAgentId)
          : directory.connected()
    const exit = await Effect.runPromiseExit(work)
    expect(tags(exit)).toEqual(["Fail"])
    expect(
      Exit.isFailure(exit) &&
        exit.cause.reasons[0]?._tag === "Fail" &&
        exit.cause.reasons[0].error._tag
    ).toBe("ActivityUnavailable")
  }
)
