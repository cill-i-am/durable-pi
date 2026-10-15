import { afterEach, expect, it, vi } from "vitest"
import { Cause, Effect, Exit, Layer, ManagedRuntime, Schema } from "effect"
import { PersonalAgent } from "../src/agent/worker"
import { backgroundParentRpc } from "../src/delegation/adapters/background-parent"
import { backgroundNative } from "../src/delegation/adapters/interop"
import { DelegationFailure } from "../src/delegation/contracts"
import {
  AccountOutcome,
  accountRpc,
  accountToken,
  nativeAccountToken,
} from "../src/inference/adapters/account-rpc"
import {
  CredentialUnavailable,
  OAuthCredential,
} from "../src/inference/credentials"
import { catalog, credential } from "./inference-fixture"
import { reportHarness } from "../src/observability/events"
import { skillResolution } from "../src/skills/adapters/resolution"
import { skillRpc, skillNative } from "../src/skills/adapters/rpc"
import { SkillConflict, SkillStorageError } from "../src/skills/contracts"

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
  vi.clearAllMocks()
})
function fixture(
  options: {
    authorized?: () => Effect.Effect<boolean, unknown>
    resolve?: () => Effect.Effect<OAuthCredential | undefined, unknown>
    owner?: string
    remote?: PersonalAgent
  } = {}
) {
  const runtime = ManagedRuntime.make(Layer.empty)
  runtimes.push(runtime)
  const resolve = vi.fn(
    options.resolve ??
      (() =>
        Effect.succeed(Schema.decodeUnknownSync(OAuthCredential)(credential)))
  )
  const host: PersonalAgent = Object.create(PersonalAgent.prototype)
  Object.assign(host, {
    actorRuntime: runtime,
    lifecycle: { start: async () => {} },
    ctx: { waitUntil: vi.fn() },
    configurationService: {
      read: () => Effect.succeed({ owner: options.owner }),
    },
    credentialService: { resolve },
    catalogService: { read: () => Effect.succeed(catalog) },
    background: {
      authorized: options.authorized ?? (() => Effect.succeed(true)),
      handoff: () =>
        Effect.fail(
          new DelegationFailure({ code: "not_found", message: "No task." })
        ),
    },
    env: {
      AGENT: {
        getByName: (owner: string) => {
          expect(owner).toBe(options.owner)
          return options.remote
        },
      },
    },
  })
  return {
    host,
    resolve,
    parent: backgroundParentRpc(host),
    account: accountRpc(host),
  }
}

it("skill resolution projects only its expected failure and preserves a tagged defect", async () => {
  const f = fixture()
  const expected = new SkillConflict({ message: "Select an available skill." })
  Object.assign(f.host, {
    skillService: { resolve: () => Effect.fail(expected) },
  })
  expect(
    await Effect.runPromise(
      skillResolution(skillNative(() => skillRpc(f.host).resolve([])))
    )
  ).toEqual({
    skills: [],
    error: expected.message,
  })
  Object.assign(f.host, {
    skillService: {
      resolve: () =>
        Effect.fail(
          new SkillStorageError({ operation: "read", cause: "private" })
        ),
    },
  })
  expect(
    await Effect.runPromise(
      skillResolution(skillNative(() => skillRpc(f.host).resolve([])))
    )
  ).toEqual({
    skills: [],
    error: "Could not load these skills.",
  })
  Object.assign(f.host, {
    skillService: { resolve: () => Effect.die(expected) },
  })
  const fatal = await Effect.runPromiseExit(
    skillResolution(skillNative(() => skillRpc(f.host).resolve([])))
  )
  expect(Exit.isFailure(fatal) && Cause.hasDies(fatal.cause)).toBe(true)
})

it("resolves an account endpoint locally when its configuration names itself", async () => {
  const f = fixture({ owner: "self-account" })
  const token = await f.account.credential("openai")
  expect(token && nativeAccountToken(token)).toEqual({
    ...credential,
    refresh: "",
  })
  expect(f.resolve).toHaveBeenCalledOnce()
})

it("forwards account credentials through the actual retained host boundary without refresh authority", async () => {
  const root = fixture()
  const child = fixture({ owner: "original-account", remote: root.host })
  const token = await child.parent.credential(19, "openai")
  expect(token).toEqual(
    accountToken(Schema.decodeUnknownSync(OAuthCredential)(credential))
  )
  expect(token && nativeAccountToken(token)).toEqual({
    ...credential,
    refresh: "",
  })
  expect(child.resolve).not.toHaveBeenCalled()
  expect(root.resolve).toHaveBeenCalledOnce()
  const wire = await child.host.backgroundParentV1({
    _tag: "Credential",
    id: 19,
    provider: "openai",
  })
  expect(JSON.stringify(wire)).toContain(credential.access)
  expect(JSON.stringify(wire)).not.toContain(credential.refresh)
  expect(JSON.stringify(wire)).not.toContain('"refresh"')
  expect(await child.account.catalog()).toEqual(catalog)
})

it.each(["wrong-provider", "stopped"])(
  "rejects %s before resolving a background token",
  async (kind) => {
    const f = fixture({ authorized: () => Effect.succeed(kind !== "stopped") })
    const exit = await Effect.runPromiseExit(
      backgroundNative(() =>
        f.parent.credential(19, kind === "wrong-provider" ? "other" : "openai")
      )
    )
    expect(Exit.isFailure(exit) && exit.cause.reasons).toMatchObject([
      { _tag: "Fail", error: { _tag: "DelegationFailure", code: "cancelled" } },
    ])
    expect(f.resolve).not.toHaveBeenCalled()
  }
)

it("rechecks background authority after credential settlement before publishing its token", async () => {
  let release!: () => void,
    entered!: () => void,
    authorized = true
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const f = fixture({
    authorized: () => Effect.succeed(authorized),
    resolve: () =>
      Effect.promise(async () => {
        entered()
        await pending
        return Schema.decodeUnknownSync(OAuthCredential)(credential)
      }),
  })
  const reading = Effect.runPromiseExit(
    backgroundNative(() => f.parent.credential(19, "openai"))
  )
  try {
    await started
    authorized = false
    release()
    const exit = await reading
    expect(Exit.isFailure(exit) && exit.cause.reasons).toMatchObject([
      { _tag: "Fail", error: { code: "cancelled" } },
    ])
    expect(JSON.stringify(exit)).not.toContain(credential.access)
    expect(JSON.stringify(exit)).not.toContain(credential.refresh)
  } finally {
    release()
    await reading
  }
})

it.each([
  {
    name: "expected",
    cause: Cause.fail(
      new DelegationFailure({ code: "cancelled", message: "Stopped" })
    ),
    tags: ["Fail"],
  },
  {
    name: "defect",
    cause: Cause.die(new Error("private token")),
    tags: ["Die"],
  },
  { name: "interrupt", cause: Cause.interrupt(731), tags: ["Interrupt"] },
  {
    name: "mixed",
    cause: Cause.fromReasons([
      Cause.makeFailReason(
        new DelegationFailure({ code: "cancelled", message: "Stopped" })
      ),
      Cause.makeDieReason(new Error("private token")),
      Cause.makeInterruptReason(731),
    ]),
    tags: ["Fail", "Die", "Interrupt"],
  },
])(
  "preserves a parent $name through its real host handler",
  async ({ cause, tags }) => {
    const f = fixture({ authorized: () => Effect.failCause(cause) })
    const exit = await Effect.runPromiseExit(
      backgroundNative(() => f.parent.authorized(19))
    )
    expect(
      Exit.isFailure(exit) && exit.cause.reasons.map((reason) => reason._tag)
    ).toEqual(tags)
    expect(JSON.stringify(exit)).not.toContain("private token")
    expect(vi.mocked(reportHarness)).toHaveBeenCalledTimes(
      tags.includes("Die") ? 1 : 0
    )
  }
)

it("preserves an expected account error without returning a credential", async () => {
  const f = fixture({
    resolve: () =>
      Effect.fail(new CredentialUnavailable({ message: "Reconnect ChatGPT." })),
  })
  const reply = await f.host.accountV1({
    _tag: "Credential",
    provider: "openai",
  })
  const decoded = AccountOutcome.decode(reply)
  expect(Exit.isFailure(decoded) && decoded.cause.reasons).toMatchObject([
    { _tag: "Fail", error: { _tag: "CredentialUnavailable" } },
  ])
  expect(JSON.stringify(reply)).not.toContain(credential.access)
})

it.each(["account", "parent"])(
  "returns a defect for an invalid %s operation",
  async (boundary) => {
    const f = fixture()
    const reply = await (boundary === "account"
      ? f.host.accountV1({ _tag: "RunAnything" })
      : f.host.backgroundParentV1({ _tag: "RunAnything" }))
    expect(JSON.stringify(reply)).toContain('"Die"')
    expect(f.resolve).not.toHaveBeenCalled()
  }
)
