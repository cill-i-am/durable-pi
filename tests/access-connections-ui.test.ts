import { it } from "@effect/vitest"
import { send, waitFor } from "@xstate/effect"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { afterEach, expect, vi } from "vitest"

import type { AccessState } from "../src/access/contracts"
import {
  makeAccessOwner,
  makeApprovalOwner,
  approvalRequest,
} from "../src/features/access/access-owner"
import type { ApprovalView } from "../src/features/access/approval.machine"
import {
  connectionCommand,
  connectionRequests,
  makeConnectionsOwner,
} from "../src/features/connections/connections-owner"
import type {
  ConnectionCatalog,
  ConnectionCommand,
} from "../src/features/connections/connections.machine"
import { nativeOperation } from "../src/shared/interop"

const policy = {
  name: "write_note",
  description: "Write note",
  mode: "ask" as const,
  revision: 2,
}
const view: ApprovalView = {
  agentId: "one",
  disabled: false,
  policy,
  approval: {
    id: "a",
    turnId: "turn",
    tool: policy.name,
    input: "old",
    createdAt: 1,
    expiresAt: 9000000000000,
    status: "pending",
    revision: 4,
  },
}
const access: AccessState = { tools: [policy], approvals: [] }
const connection = {
  id: `mcp-${"a".repeat(32)}`,
  name: "Tools",
  url: "https://tools.example.com/mcp",
  revision: 3,
  active: true,
  status: "unavailable" as const,
  authorizeUrl: null,
  tools: [],
}
const catalog: ConnectionCatalog = {
  library: { connections: [connection] },
  selection: { revision: 2, tools: [] },
}
const reconnect: ConnectionCommand = {
  action: "reconnect",
  body: { id: connection.id, expectedRevision: 3 },
}
const request = (
  requestId: string,
  command: ConnectionCommand = reconnect,
  agentId: string | undefined = undefined
) => ({ requestId, agentId, command })
afterEach(() => vi.unstubAllGlobals())

it.effect(
  "fences a decision response after identity, input, revision or agent changes",
  () =>
    Effect.gen(function* () {
      for (const replacement of [
        { ...view, agentId: "two" },
        { ...view, approval: { ...view.approval, id: "b" } },
        { ...view, approval: { ...view.approval, input: "new" } },
        { ...view, approval: { ...view.approval, revision: 5 } },
      ]) {
        const release = yield* Deferred.make<AccessState>()
        const actor = yield* makeApprovalOwner(view, () =>
          Deferred.await(release)
        )
        yield* send(actor, {
          type: "SUBMIT",
          view,
          approve: true,
          remember: false,
        })
        yield* waitFor(actor, (s) => s.matches("submitting"))
        yield* send(actor, { type: "VIEW", ...replacement })
        yield* waitFor(
          actor,
          (s) =>
            s.context.view === replacement ||
            (s.context.view.agentId === replacement.agentId &&
              s.context.view.approval.input === replacement.approval.input &&
              s.context.view.approval.id === replacement.approval.id &&
              s.context.view.approval.revision ===
                replacement.approval.revision)
        )
        yield* Deferred.succeed(release, access)
        yield* waitFor(actor, (s) => s.matches("ready"))
        expect(actor.getSnapshot().context.confirmed).toBeNull()
      }
    }).pipe(Effect.scoped)
)

it.effect(
  "serializes decisions and only permits the identical uncertain decision to retry",
  () =>
    Effect.gen(function* () {
      let calls = 0
      const first = yield* Deferred.make<AccessState, Error>()
      const actor = yield* makeApprovalOwner(view, () => {
        calls++
        return calls === 1 ? Deferred.await(first) : Effect.succeed(access)
      })
      yield* send(actor, {
        type: "SUBMIT",
        view,
        approve: true,
        remember: false,
      })
      yield* waitFor(actor, (s) => s.matches("submitting"))
      yield* send(actor, {
        type: "SUBMIT",
        view,
        approve: false,
        remember: false,
      })
      yield* Deferred.fail(first, new Error("lost acknowledgement"))
      yield* waitFor(actor, (s) => s.matches("uncertain"))
      yield* send(actor, {
        type: "SUBMIT",
        view,
        approve: false,
        remember: false,
      })
      yield* send(actor, {
        type: "SUBMIT",
        view,
        approve: true,
        remember: true,
      })
      yield* Effect.yieldNow
      expect(calls).toBe(1)
      expect(actor.getSnapshot().context.confirmed).toBeNull()
      yield* send(actor, {
        type: "SUBMIT",
        view,
        approve: true,
        remember: false,
      })
      yield* waitFor(actor, (s) => s.context.confirmed !== null)
      expect(calls).toBe(2)
      expect(actor.getSnapshot().context.confirmed?.approval).toEqual(
        view.approval
      )
    }).pipe(Effect.scoped)
)

it.effect(
  "rejects stale policy, disabled authority and malformed decision events",
  () =>
    Effect.gen(function* () {
      let calls = 0
      const actor = yield* makeApprovalOwner(view, () =>
        Effect.sync(() => {
          calls++
          return access
        })
      )
      yield* send(actor, {
        type: "SUBMIT",
        view: { ...view, policy: { ...policy, revision: 1 } },
        approve: true,
        remember: true,
      })
      yield* send(actor, { type: "VIEW", ...view, disabled: true })
      yield* send(actor, {
        type: "SUBMIT",
        view,
        approve: true,
        remember: false,
      })
      yield* send(actor, {
        type: "SUBMIT",
        view,
        approve: "yes",
        remember: false,
      } as never)
      yield* Effect.yieldNow
      expect(calls).toBe(0)
      expect(actor.getSnapshot().context.confirmed).toBeNull()
    }).pipe(Effect.scoped)
)

it.effect(
  "posts only exact approval and policy revisions through the production adapter",
  () =>
    Effect.gen(function* () {
      const calls: unknown[] = []
      vi.stubGlobal("fetch", (url: string, options: RequestInit) => {
        calls.push({ url, body: JSON.parse(options.body as string) })
        return Promise.resolve(
          Response.json({ ...access, tools: [{ ...policy, mode: "allow" }] })
        )
      })
      yield* approvalRequest({ view, approve: true, remember: true })
      expect(calls).toEqual([
        {
          url: "/api/agent/access/decide?agent=one",
          body: {
            id: "a",
            expectedRevision: 4,
            approve: true,
            remember: { expectedPolicyRevision: 2 },
          },
        },
      ])
    }).pipe(Effect.scoped)
)

it.effect(
  "serializes policy writes and does not replace a pending mutation with reload or close",
  () =>
    Effect.gen(function* () {
      let reads = 0,
        writes = 0
      const release = yield* Deferred.make<AccessState>()
      const actor = yield* makeAccessOwner(
        { agentId: "one", open: true },
        {
          read: () =>
            Effect.sync(() => {
              reads++
              return access
            }),
          update: () => {
            writes++
            return Deferred.await(release)
          },
        }
      )
      yield* waitFor(actor, (s) => s.matches("ready"))
      yield* send(actor, {
        type: "CHANGE",
        name: policy.name,
        expectedRevision: 2,
        mode: "deny",
      })
      yield* waitFor(actor, (s) => s.matches("saving"))
      yield* send(actor, { type: "REFRESH" })
      yield* send(actor, {
        type: "CHANGE",
        name: policy.name,
        expectedRevision: 2,
        mode: "allow",
      })
      yield* send(actor, { type: "VIEW", open: false })
      yield* Effect.yieldNow
      expect(actor.getSnapshot().matches("saving")).toBe(true)
      expect(reads).toBe(1)
      expect(writes).toBe(1)
      yield* Deferred.succeed(release, {
        tools: [{ ...policy, mode: "deny", revision: 3 }],
        approvals: [],
      })
      yield* waitFor(actor, (s) => s.matches("hidden"))
      expect(actor.getSnapshot().context.state?.tools[0]?.mode).toBe("deny")
    }).pipe(Effect.scoped)
)

it.effect("does not grant a local policy on an unconfirmed write", () =>
  Effect.gen(function* () {
    const actor = yield* makeAccessOwner(
      { agentId: "one", open: true },
      {
        read: () => Effect.succeed(access),
        update: () => Effect.fail(new Error("lost")),
      }
    )
    yield* waitFor(actor, (s) => s.matches("ready"))
    yield* send(actor, {
      type: "CHANGE",
      name: policy.name,
      expectedRevision: 2,
      mode: "allow",
    })
    yield* waitFor(actor, (s) => s.context.error.length > 0)
    expect(actor.getSnapshot().context.state).toEqual(access)
  }).pipe(Effect.scoped)
)

it.effect("fences an obsolete catalog response after an explicit refresh", () =>
  Effect.gen(function* () {
    let release!: (value: ConnectionCatalog) => void
    let signal: AbortSignal | undefined
    let reads = 0
    const started = yield* Deferred.make<void>()
    const actor = yield* makeConnectionsOwner(
      { agentId: undefined, open: true },
      {
        read: () =>
          ++reads === 1
            ? nativeOperation(
                (s) => {
                  signal = s
                  Effect.runSync(Deferred.succeed(started, undefined))
                  return new Promise<ConnectionCatalog>((resolve) => {
                    release = resolve
                  })
                },
                (cause) => cause
              )
            : Effect.succeed({
                ...catalog,
                selection: { revision: 4, tools: [] },
              }),
        command: () => Effect.die("unexpected"),
      }
    )
    yield* Deferred.await(started)
    yield* send(actor, { type: "REFRESH" })
    yield* waitFor(actor, (s) => s.matches("ready"))
    expect(signal?.aborted).toBe(true)
    release(catalog)
    yield* Effect.yieldNow
    expect(actor.getSnapshot().context.catalog?.selection.revision).toBe(4)
  }).pipe(Effect.scoped)
)

it.effect(
  "retains reconnect identity after uncertainty, rejects conflicts and never automatically replays",
  () =>
    Effect.gen(function* () {
      const calls: ConnectionCommand[] = []
      const release = yield* Deferred.make<void>()
      const actor = yield* makeConnectionsOwner(
        { agentId: undefined, open: true },
        {
          read: () => Effect.succeed(catalog),
          command: (input) =>
            Effect.gen(function* () {
              calls.push(input)
              if (calls.length === 1) {
                yield* Deferred.await(release)
                return yield* Effect.fail(new Error("lost"))
              }
              return {
                kind: "library" as const,
                value: {
                  connections: [
                    {
                      ...connection,
                      revision: 4,
                      status: "authorization" as const,
                      authorizeUrl: "https://provider.example.com/authorize",
                    },
                  ],
                },
              }
            }),
        }
      )
      yield* waitFor(actor, (s) => s.matches("ready"))
      const pending = yield* connectionCommand(actor, request("first")).pipe(
        Effect.forkChild
      )
      yield* waitFor(actor, (s) => s.matches("mutating"))
      expect(yield* connectionCommand(actor, request("duplicate"))).toBe(false)
      yield* send(actor, { type: "REFRESH" })
      yield* Effect.yieldNow
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(pending)).toBe(false)
      expect(actor.getSnapshot().context.catalog).toEqual(catalog)
      expect(
        yield* connectionCommand(
          actor,
          request("disconnect", { action: "disconnect", body: reconnect.body })
        )
      ).toBe(false)
      expect(
        yield* connectionCommand(
          actor,
          request("stale-agent", reconnect, "two")
        )
      ).toBe(false)
      expect(calls).toHaveLength(1)
      expect(yield* connectionCommand(actor, request("retry"))).toBe(true)
      expect(calls).toEqual([reconnect, reconnect])
      expect(
        actor.getSnapshot().context.catalog?.library.connections[0]?.status
      ).toBe("authorization")
    }).pipe(Effect.scoped)
)

it.effect(
  "reload after uncertainty only observes SDK state and uses no new mutation",
  () =>
    Effect.gen(function* () {
      let mutations = 0,
        reads = 0
      const actor = yield* makeConnectionsOwner(
        { agentId: undefined, open: true },
        {
          read: () =>
            Effect.sync(() => {
              reads++
              return catalog
            }),
          command: () => {
            mutations++
            return Effect.fail(new Error("unknown"))
          },
        }
      )
      yield* waitFor(actor, (s) => s.matches("ready"))
      expect(yield* connectionCommand(actor, request("one"))).toBe(false)
      yield* send(actor, { type: "REFRESH" })
      yield* waitFor(actor, (s) => s.matches("ready"))
      expect(mutations).toBe(1)
      expect(reads).toBe(2)
      expect(
        actor.getSnapshot().context.catalog?.library.connections[0]?.status
      ).toBe("unavailable")
    }).pipe(Effect.scoped)
)

it.effect(
  "production connection adapter keeps workspace ownership and the selected agent separate",
  () =>
    Effect.gen(function* () {
      const calls: { url: string; body: unknown }[] = []
      vi.stubGlobal("fetch", (url: string, options: RequestInit) => {
        calls.push({
          url,
          body: options.body ? JSON.parse(options.body as string) : null,
        })
        return Promise.resolve(
          Response.json(
            url.includes("remote-tools") ? catalog.selection : catalog.library
          )
        )
      })
      const work = connectionRequests("two")
      yield* work.read()
      expect(Exit.isFailure(yield* Effect.exit(work.command(reconnect)))).toBe(
        true
      )
      const library = connectionRequests(undefined)
      yield* library.read()
      yield* library.command(reconnect)
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            library.command({
              action: "select",
              body: { expectedRevision: 2, names: [] },
            })
          )
        )
      ).toBe(true)
      yield* work.command({
        action: "select",
        body: { expectedRevision: 2, names: [] },
      })
      expect(calls.some((call) => call.url.includes("agent=undefined"))).toBe(
        false
      )
      expect(calls).toContainEqual({
        url: "/api/agent/remote-tools?agent=two",
        body: null,
      })
      expect(calls).toContainEqual({
        url: "/api/agent/connections/reconnect?agent=home",
        body: reconnect.body,
      })
    }).pipe(Effect.scoped)
)

it.effect(
  "closing owns HTTP settlement and retains a late compound cleanup Cause",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      let release!: (reason: unknown) => void
      let signal: AbortSignal | undefined
      const started = yield* Deferred.make<void>()
      const checked = new Error("checked"),
        defect = new Error("cleanup")
      const actor = yield* makeConnectionsOwner(
        { agentId: undefined, open: true },
        {
          read: () => Effect.succeed(catalog),
          command: () =>
            nativeOperation(
              (s) => {
                signal = s
                Effect.runSync(Deferred.succeed(started, undefined))
                return new Promise<never>((_, reject) => {
                  release = reject
                })
              },
              (cause) => cause
            ),
        }
      ).pipe(Effect.provideService(Scope.Scope, scope))
      yield* waitFor(actor, (s) => s.matches("ready"))
      const pending = yield* connectionCommand(actor, request("one")).pipe(
        Effect.forkChild
      )
      yield* Deferred.await(started)
      const close = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(signal?.aborted).toBe(true)
      expect(close.pollUnsafe()).toBeUndefined()
      release(Cause.combine(Cause.fail(checked), Cause.die(defect)))
      const exit = yield* Fiber.await(close)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(
          exit.cause.reasons.some(
            (reason) => reason._tag === "Die" && reason.defect === defect
          )
        ).toBe(true)
        expect(
          exit.cause.reasons.some(
            (reason) =>
              (reason._tag === "Fail" && reason.error === checked) ||
              (reason._tag === "Die" &&
                Cause.isReason(reason.defect) &&
                Cause.isFailReason(reason.defect) &&
                reason.defect.error === checked)
          )
        ).toBe(true)
      }
      expect(yield* Fiber.join(pending)).toBe(false)
    }).pipe(Effect.scoped)
)

it.effect(
  "an uncertain always-allow decision cannot use a newer policy revision as retry authority",
  () =>
    Effect.gen(function* () {
      let calls = 0
      const actor = yield* makeApprovalOwner(view, () => {
        calls++
        return Effect.fail(new Error("unconfirmed"))
      })
      yield* send(actor, {
        type: "SUBMIT",
        view,
        approve: true,
        remember: true,
      })
      yield* waitFor(actor, (s) => s.matches("uncertain"))
      const newer = { ...view, policy: { ...policy, revision: 3 } }
      yield* send(actor, { type: "VIEW", ...newer })
      yield* send(actor, {
        type: "SUBMIT",
        view: newer,
        approve: true,
        remember: true,
      })
      yield* Effect.yieldNow
      expect(calls).toBe(1)
      expect(actor.getSnapshot().context.request?.view.policy?.revision).toBe(2)
    }).pipe(Effect.scoped)
)

it.effect(
  "an uncertain add retains the exact server identity and immutable endpoint",
  () =>
    Effect.gen(function* () {
      const calls: ConnectionCommand[] = []
      const add: ConnectionCommand = {
        action: "add",
        body: {
          id: `mcp-${"b".repeat(32)}`,
          name: "New tools",
          url: "https://new.example.com/mcp",
        },
      }
      const actor = yield* makeConnectionsOwner(
        { agentId: undefined, open: true },
        {
          read: () => Effect.succeed(catalog),
          command: (input) => {
            calls.push(input)
            return Effect.fail(new Error("lost"))
          },
        }
      )
      yield* waitFor(actor, (s) => s.matches("ready"))
      expect(yield* connectionCommand(actor, request("first", add))).toBe(false)
      expect(
        yield* connectionCommand(
          actor,
          request("changed", {
            ...add,
            body: { ...add.body, url: "https://changed.example.com/mcp" },
          })
        )
      ).toBe(false)
      expect(yield* connectionCommand(actor, request("retry", add))).toBe(false)
      expect(calls).toEqual([add, add])
    }).pipe(Effect.scoped)
)

it.effect(
  "a newer policy fences a late always-allow acknowledgement without losing the action decision",
  () =>
    Effect.gen(function* () {
      for (const timing of ["before", "after"] as const) {
        const release = yield* Deferred.make<AccessState>()
        const actor = yield* makeApprovalOwner(view, () =>
          Deferred.await(release)
        )
        yield* send(actor, {
          type: "SUBMIT",
          view,
          approve: true,
          remember: true,
        })
        yield* waitFor(actor, (s) => s.matches("submitting"))
        const newer = {
          ...view,
          policy: { ...policy, mode: "deny" as const, revision: 4 },
        }
        if (timing === "before") {
          yield* send(actor, { type: "VIEW", ...newer })
          yield* waitFor(actor, (s) => s.context.view.policy?.revision === 4)
        }
        yield* Deferred.succeed(release, {
          tools: [{ ...policy, mode: "allow", revision: 3 }],
          approvals: [],
        })
        yield* waitFor(actor, (s) => s.matches("ready"))
        if (timing === "after") {
          expect(actor.getSnapshot().context.confirmed?.remember).toBe(true)
          yield* send(actor, { type: "VIEW", ...newer })
          yield* waitFor(actor, (s) => s.context.view.policy?.revision === 4)
        }
        expect(actor.getSnapshot().context.view.policy).toEqual(newer.policy)
        expect(actor.getSnapshot().context.confirmed?.approve).toBe(true)
        expect(actor.getSnapshot().context.confirmed?.remember).toBe(false)
      }
    }).pipe(Effect.scoped)
)

it.effect(
  "all access and connection owners retain every annotated native cleanup reason",
  () =>
    Effect.gen(function* () {
      for (const kind of ["approval", "access", "connections"] as const) {
        const scope = yield* Scope.make()
        const started = yield* Deferred.make<void>()
        const aborted = yield* Deferred.make<void>()
        let reject!: (cause: unknown) => void
        const annotations = Context.makeUnsafe(new Map([["f06-cleanup", kind]]))
        const native = Cause.fromReasons([
          Cause.makeFailReason(new Error("checked")).annotate(annotations),
          Cause.makeDieReason(new Error("cleanup")).annotate(annotations),
          Cause.makeInterruptReason(86123).annotate(annotations),
        ])
        const work = () =>
          nativeOperation<AccessState, unknown>(
            (signal) =>
              new Promise((_, fail) => {
                reject = fail
                signal.addEventListener("abort", () =>
                  Effect.runSync(Deferred.succeed(aborted, undefined))
                )
                Effect.runSync(Deferred.succeed(started, undefined))
              }),
            (cause) => cause
          )
        let pending: Fiber.Fiber<boolean, unknown> | undefined
        if (kind === "approval") {
          const actor = yield* makeApprovalOwner(view, work).pipe(
            Scope.provide(scope)
          )
          yield* send(actor, {
            type: "SUBMIT",
            view,
            approve: true,
            remember: false,
          })
        } else if (kind === "access") {
          const actor = yield* makeAccessOwner(
            { agentId: "one", open: true },
            { read: () => Effect.succeed(access), update: work }
          ).pipe(Scope.provide(scope))
          yield* waitFor(actor, (s) => s.matches("ready"))
          yield* send(actor, {
            type: "CHANGE",
            name: policy.name,
            expectedRevision: 2,
            mode: "deny",
          })
        } else {
          const actor = yield* makeConnectionsOwner(
            { agentId: undefined, open: true },
            {
              read: () => Effect.succeed(catalog),
              command: () =>
                work().pipe(
                  Effect.as({
                    kind: "library" as const,
                    value: catalog.library,
                  })
                ),
            }
          ).pipe(Scope.provide(scope))
          yield* waitFor(actor, (s) => s.matches("ready"))
          pending = yield* Effect.forkChild(
            connectionCommand(actor, request("cleanup"))
          )
        }
        yield* Deferred.await(started)
        const closing = yield* Effect.forkChild(
          Effect.exit(Scope.close(scope, Exit.void))
        )
        yield* Deferred.await(aborted)
        expect(closing.pollUnsafe()).toBeUndefined()
        reject(native)
        const exit = yield* Fiber.join(closing)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          for (const reason of native.reasons) {
            const present = exit.cause.reasons
              .map((value) =>
                value._tag === "Die" && Cause.isReason(value.defect)
                  ? value.defect
                  : value
              )
              .find((value) => {
                if (value._tag !== reason._tag) return false
                if (value._tag === "Fail" && reason._tag === "Fail")
                  return value.error === reason.error
                if (value._tag === "Die" && reason._tag === "Die")
                  return value.defect === reason.defect
                return (
                  value._tag === "Interrupt" &&
                  reason._tag === "Interrupt" &&
                  value.fiberId === reason.fiberId
                )
              })
            expect(present, `${kind} retains ${reason._tag}`).toBeDefined()
            for (const [key, value] of reason.annotations) {
              expect(present?.annotations.get(key)).toEqual(value)
            }
          }
        }
        if (pending) expect(yield* Fiber.join(pending)).toBe(false)
      }
    }).pipe(Effect.scoped)
)

it.effect(
  "connection library and per-agent selection reject each other's commands",
  () =>
    Effect.gen(function* () {
      for (const agentId of [undefined, "two"]) {
        const calls: ConnectionCommand[] = []
        const actor = yield* makeConnectionsOwner(
          { agentId, open: true },
          {
            read: () => Effect.succeed(catalog),
            command: (input) => {
              calls.push(input)
              return Effect.succeed({
                kind: "selection" as const,
                value: catalog.selection,
              })
            },
          }
        )
        yield* waitFor(actor, (state) => state.matches("ready"))
        const select: ConnectionCommand = {
          action: "select",
          body: { expectedRevision: 2, names: [] },
        }
        const denied = agentId === undefined ? select : reconnect
        expect(
          yield* connectionCommand(actor, request("denied", denied, agentId))
        ).toBe(false)
        expect(calls).toEqual([])
        const allowed = agentId === undefined ? reconnect : select
        expect(
          yield* connectionCommand(actor, request("allowed", allowed, agentId))
        ).toBe(true)
        expect(calls).toEqual([allowed])
      }
    }).pipe(Effect.scoped)
)
