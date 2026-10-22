import { Cause, Effect, Exit, Layer, ManagedRuntime, Schema } from "effect"
import { afterEach, expect, it, vi } from "vitest"

import { remoteToolResolution } from "../src/access/adapters/resolution"
import {
  ConnectionOutcome,
  ConnectionRequest,
  connectionNative,
  connectionRpc,
} from "../src/access/adapters/rpc"
import {
  ConnectionError,
  ConnectionStorageError,
  ConnectionTransportError,
  type RemoteTool,
  type RemoteToolResult,
} from "../src/access/connections"
import { PersonalAgent } from "../src/agent/worker"
import { skillResolution } from "../src/skills/adapters/resolution"
import { SkillOutcome, skillNative, skillRpc } from "../src/skills/adapters/rpc"
import {
  SkillConflict,
  SkillStorageError,
  type SkillDocument,
} from "../src/skills/contracts"

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
  RpcTarget: class {},
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
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const name = `mcp_${"a".repeat(40)}`
const tool: RemoteTool = {
  name,
  connectionId: `mcp-${"b".repeat(32)}`,
  connectionRevision: 1,
  connectionName: "Synthetic provider",
  remoteName: "read",
  description: "Synthetic read",
  parameters: { type: "object", properties: {} },
}
const result: RemoteToolResult = {
  content: [
    { type: "text", text: "result" },
    { type: "image", data: "AA==", mimeType: "image/png" },
  ],
  isError: false,
  diagnostics: [{ severity: "info", code: "done", message: "Complete" }],
}
const skill: SkillDocument = {
  id: crypto.randomUUID(),
  name: "Fixture skill",
  revision: 1,
  body: "Synthetic instructions.",
  createdAt: "2026-10-15T00:00:00Z",
}
function fixture(
  options: {
    tools?: () => Effect.Effect<
      RemoteTool[],
      ConnectionError | ConnectionStorageError | ConnectionTransportError
    >
    call?: () => Effect.Effect<
      RemoteToolResult,
      ConnectionError | ConnectionStorageError | ConnectionTransportError
    >
    skills?: () => Effect.Effect<
      SkillDocument[],
      SkillConflict | SkillStorageError
    >
  } = {}
) {
  const runtime = ManagedRuntime.make(Layer.empty)
  runtimes.push(runtime)
  const host: PersonalAgent = Object.create(PersonalAgent.prototype)
  const resolve = vi.fn(options.tools ?? (() => Effect.succeed([tool])))
  const call = vi.fn(options.call ?? (() => Effect.succeed(result)))
  const defaults = vi.fn(options.tools ?? (() => Effect.succeed([tool])))
  const skills = vi.fn(options.skills ?? (() => Effect.succeed([skill])))
  const waitUntil = vi.fn<(work: Promise<unknown>) => void>()
  Object.assign(host, {
    actorRuntime: runtime,
    familyAdmission: async () => ({
      owner: "fixture",
      modelOwner: "fixture",
      joinedAt: 1,
    }),
    lifecycle: { start: async () => {} },
    ctx: { waitUntil },
    connections: { resolve, call, defaults },
    skillService: { resolve: skills },
  })
  return {
    host,
    runtime,
    defaults,
    resolve,
    call,
    skills,
    waitUntil,
    connections: connectionRpc(host),
    skillClient: skillRpc(host),
  }
}
const tags = <T, TError>(exit: Exit.Exit<T, TError>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.map((reason) => reason._tag) : []

it("treats a previous-version owner as having no defaults while its actor drains", async () => {
  const previousRequest = Schema.Struct({
    _tag: Schema.Literal("Resolve"),
    names: Schema.Array(Schema.String),
  })
  const previous = connectionRpc({
    connectionsV1: async (raw) => {
      const decoded = Schema.decodeUnknownSync(previousRequest)(raw)
      expect(decoded).toEqual({ _tag: "Resolve", names: [] })
      return ConnectionOutcome.encode(Exit.succeed([]))
    },
  })
  expect(await previous.defaults()).toEqual([])
})

it("installs workspace defaults through the real owner RPC for existing and new agents, then removes disconnected defaults", async () => {
  const inherited = { ...tool, remoteName: "search" }
  const f = fixture({ tools: () => Effect.succeed([inherited]) })
  for (const selected of [
    [],
    [{ ...tool, name: `mcp_${"c".repeat(40)}` }],
  ] as RemoteTool[][]) {
    const child: PersonalAgent = Object.create(PersonalAgent.prototype)
    const install = vi.fn()
    Object.assign(child, {
      familyAdmission: async () => ({
        owner: "synthetic-owner",
        modelOwner: "synthetic-owner",
        joinedAt: 1,
      }),
      actorRuntime: f.runtime,
      configurationService: {
        read: () => Effect.succeed({ owner: "synthetic-owner" }),
      },
      remoteSelection: {
        selection: () =>
          Effect.succeed({ revision: selected.length, tools: selected }),
      },
      env: {
        AGENT: {
          getByName: (owner: string) => {
            expect(owner).toBe("synthetic-owner")
            return f.host
          },
        },
      },
      installRemoteTools: install,
      active: () => Effect.succeed(undefined),
      conversationPump: { run: () => Effect.succeed(undefined) },
    })
    await child.step()
    expect(install).toHaveBeenLastCalledWith([inherited, ...selected])
    f.defaults.mockImplementation(() => Effect.succeed([]))
    await child.step()
    expect(install).toHaveBeenLastCalledWith(selected)
    f.defaults.mockImplementation(() => Effect.succeed([inherited]))
  }
  expect(f.defaults).toHaveBeenCalledTimes(4)
})

it("uses the actual owner handlers for tool definitions, arguments, results and pinned skill versions", async () => {
  const f = fixture()
  expect(await f.connections.resolve([name])).toEqual([tool])
  expect(await f.connections.call(name, '{"value":"original"}')).toEqual(result)
  expect(f.call).toHaveBeenCalledWith(name, { value: "original" })
  expect(await f.skillClient.resolve([{ id: skill.id, revision: 1 }])).toEqual([
    skill,
  ])
  expect(f.skills).toHaveBeenCalledWith([{ id: skill.id, revision: 1 }])
  expect(f.waitUntil).toHaveBeenCalledTimes(3)
})
it.each(["connection", "skill"])(
  "preserves expected, defect, interruption and compound %s outcomes",
  async (boundary) => {
    const expected =
      boundary === "connection"
        ? new ConnectionError({ message: "Reload this tool." })
        : new SkillConflict({ message: "Reload this skill." })
    for (const reasons of [
      [Cause.makeFailReason(expected)],
      [Cause.makeDieReason(new Error("private defect"))],
      [Cause.makeInterruptReason(71)],
      [
        Cause.makeFailReason(expected),
        Cause.makeDieReason(new Error("private compound defect")),
        Cause.makeInterruptReason(71),
      ],
    ]) {
      const f = fixture()
      const work: Effect.Effect<unknown, unknown> =
        boundary === "connection"
          ? connectionNative(() => f.connections.resolve([name]))
          : skillNative(() => f.skillClient.resolve([]))
      Object.assign(
        boundary === "connection" ? f.host.connections : f.host.skillService,
        { resolve: () => Effect.failCause(Cause.fromReasons(reasons)) }
      )
      const exit = await Effect.runPromiseExit(work)
      expect(tags(exit)).toEqual(reasons.map((reason) => reason._tag))
      expect(JSON.stringify(exit)).not.toContain("private")
    }
  }
)
it("redacts private expected storage/transport diagnostics while retaining their tags and operation", async () => {
  for (const error of [
    new ConnectionStorageError({
      operation: "read tools",
      cause: new Error("private database token"),
    }),
    new ConnectionTransportError({
      operation: "call tool",
      cause: "private provider secret",
    }),
  ]) {
    const f = fixture({ tools: () => Effect.fail(error) })
    const raw = await f.host.connectionsV1({ _tag: "Resolve", names: [name] })
    expect(JSON.stringify(raw)).not.toContain("private")
    const exit = ConnectionOutcome.decode(raw)
    expect(Exit.isFailure(exit) && exit.cause.reasons).toMatchObject([
      { _tag: "Fail", error: { _tag: error._tag, operation: error.operation } },
    ])
  }
  const f = fixture({
    skills: () =>
      Effect.fail(
        new SkillStorageError({
          operation: "read versions",
          cause: "private skill record",
        })
      ),
  })
  const raw = await f.host.skillVersionsV1([])
  expect(JSON.stringify(raw)).not.toContain("private")
  expect(tags(SkillOutcome.decode(raw))).toEqual(["Fail"])
})
it("projects expected wire failures only after decoding, without converting a tagged defect into a selection error", async () => {
  const f = fixture({
    tools: () =>
      Effect.fail(new ConnectionError({ message: "Select a connected tool." })),
    skills: () =>
      Effect.fail(new SkillConflict({ message: "Select a current skill." })),
  })
  expect(
    await Effect.runPromise(
      remoteToolResolution(
        connectionNative(() => f.connections.resolve([name]))
      )
    )
  ).toEqual({ tools: [], error: "Select a connected tool." })
  expect(
    await Effect.runPromise(
      skillResolution(skillNative(() => f.skillClient.resolve([])))
    )
  ).toEqual({ skills: [], error: "Select a current skill." })
  Object.assign(f.host.connections, {
    resolve: () =>
      Effect.die(
        new ConnectionError({ message: "private programming failure" })
      ),
  })
  const exit = await Effect.runPromiseExit(
    remoteToolResolution(connectionNative(() => f.connections.resolve([name])))
  )
  expect(tags(exit)).toEqual(["Die"])
})
it("rejects malformed protocol input without calling an owned capability", async () => {
  const f = fixture()
  for (const input of [
    { _tag: "DeleteEverything" },
    { _tag: "Resolve", names: ["bad"] },
    { _tag: "Call", name, argumentsJson: "x".repeat(64_001) },
  ]) {
    expect(
      tags(ConnectionOutcome.decode(await f.host.connectionsV1(input)))
    ).toEqual(["Die"])
  }
  expect(
    tags(
      SkillOutcome.decode(
        await f.host.skillVersionsV1([{ id: "bad", revision: 1 }])
      )
    )
  ).toEqual(["Die"])
  expect(f.resolve).not.toHaveBeenCalled()
  expect(f.call).not.toHaveBeenCalled()
  expect(f.skills).not.toHaveBeenCalled()
})
it.each(["[]", "null", '"private-input"', "1", "private-input"])(
  "keeps malformed JSON tool arguments in the declared failure channel without dispatching (%s)",
  async (input) => {
    const f = fixture()
    const exit = await Effect.runPromiseExit(
      connectionNative(() => f.connections.call(name, input))
    )
    expect(tags(exit)).toEqual(["Fail"])
    expect(Exit.isFailure(exit) && exit.cause.reasons).toMatchObject([
      { _tag: "Fail", error: { _tag: "ConnectionError" } },
    ])
    expect(f.call).not.toHaveBeenCalled()
  }
)
it("rejects wrong-operation and malformed results as defects before accepting a tool result", async () => {
  const f = fixture()
  const resolved = await f.host.connectionsV1({
    _tag: "Resolve",
    names: [name],
  })
  const wrong = connectionRpc({ connectionsV1: async () => resolved })
  const exit = await Effect.runPromiseExit(
    connectionNative(() => wrong.call(name, "{}"))
  )
  expect(tags(exit)).toEqual(["Die"])
  Object.assign(f.host.connections, {
    call: () => Effect.succeed({ content: [{ type: "unknown" }] }),
  })
  expect(
    tags(
      ConnectionOutcome.decode(
        await f.host.connectionsV1(
          Schema.decodeUnknownSync(ConnectionRequest)({
            _tag: "Call",
            name,
            argumentsJson: "{}",
          })
        )
      )
    )
  ).toEqual(["Die"])
})
it("rejects a non-JSON tool definition at its wire boundary", async () => {
  const f = fixture({
    tools: () =>
      Effect.succeed([
        {
          ...tool,
          parameters: { type: "object", invalid: () => "not wire data" },
        },
      ]),
  })
  expect(
    tags(
      ConnectionOutcome.decode(
        await f.host.connectionsV1({ _tag: "Resolve", names: [name] })
      )
    )
  ).toEqual(["Die"])
})
it("joins a late remote defect after cancellation instead of reporting completion early", async () => {
  const pending = deferred<unknown>(),
    entered = deferred<void>(),
    controller = new AbortController()
  const client = connectionRpc({
    connectionsV1: () => {
      entered.resolve()
      return pending.promise
    },
  })
  let settled = false
  const observed = Effect.runPromiseExit(
    connectionNative(() => client.resolve([name])),
    { signal: controller.signal }
  ).then((exit) => {
    settled = true
    return exit
  })
  await entered.promise
  controller.abort()
  await Promise.resolve()
  expect(settled).toBe(false)
  pending.resolve(
    ConnectionOutcome.encode(Exit.die(new Error("private late defect")))
  )
  const exit = await observed
  expect(tags(exit)).toEqual(["Interrupt", "Die"])
})
