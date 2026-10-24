import { it } from "@effect/vitest"
import { createEffectActor, send, waitFor } from "@xstate/effect"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { TestClock } from "effect/testing"
import { afterEach, describe, expect, vi } from "vitest"

import type { BrowserState } from "@/browser/contracts"
import {
  browserCommand,
  browserRequests,
  makeBrowserOwner,
} from "@/features/browser/browser-owner"
import { browserPreviewMachine } from "@/features/browser/browser-preview.machine"
import type { BrowserRequest } from "@/features/browser/browser.machine"
import { nativeOperation } from "@/shared/interop"

const state = (generation = 1): BrowserState => ({
  controller: "owner",
  policy: { generation, hosts: [] },
  version: 7,
  status: "ready",
  expiresAt: 9000,
  page: null,
  hasScreenshot: true,
  error: null,
})
const request = (id: string, path = "interact"): BrowserRequest => ({
  id,
  path,
  body: { generation: 1, version: 7, action: { kind: "key", key: "Tab" } },
  interrupt: false,
})
const view = { agentId: "one", visible: true }
afterEach(() => vi.unstubAllGlobals())

describe("Browser UI observation and commands", () => {
  it.effect(
    "admits one immutable command and preserves it across visibility and ignored refreshes",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<BrowserState>()
        const calls: BrowserRequest[] = []
        let reads = 0
        const actor = yield* makeBrowserOwner(view, {
          read: () =>
            Effect.sync(() => {
              reads++
              return state()
            }),
          command: (input) =>
            Effect.gen(function* () {
              calls.push(input)
              yield* Deferred.succeed(started, undefined)
              return yield* Deferred.await(release)
            }),
        })
        yield* waitFor(actor, (s) => s.matches({ resource: "waiting" }))
        const first = request("action-1")
        const pending = yield* browserCommand(actor, first).pipe(
          Effect.forkChild
        )
        yield* Deferred.await(started)
        expect(yield* browserCommand(actor, request("action-2"))).toBe(false)
        expect(
          yield* browserCommand(actor, { ...request("open"), interrupt: true })
        ).toBe(false)
        yield* send(actor, { type: "REFRESH" })
        yield* send(actor, { type: "VISIBILITY", visible: false })
        yield* waitFor(actor, (s) => !s.context.view.visible)
        expect(actor.getSnapshot().matches({ command: "requesting" })).toBe(
          true
        )
        expect(actor.getSnapshot().context.request).toEqual(first)
        expect(reads).toBe(1)
        yield* Deferred.succeed(release, state(2))
        expect(yield* Fiber.join(pending)).toBe(true)
        yield* waitFor(actor, (s) => s.matches({ resource: "hidden" }))
        expect(calls).toEqual([first])
        expect(actor.getSnapshot().context.state?.policy.generation).toBe(2)
        expect(reads).toBe(1)
      }).pipe(Effect.scoped)
  )

  it.effect(
    "polls only while visible and does not replay failed or uncertain actions",
    () =>
      Effect.gen(function* () {
        let reads = 0,
          commands = 0
        const uncertain = {
          ...state(),
          status: "error" as const,
          error: "The browser action outcome is uncertain.",
        }
        const actor = yield* makeBrowserOwner(
          { ...view, visible: false },
          {
            read: () =>
              Effect.sync(() => {
                reads++
                return uncertain
              }),
            command: () =>
              Effect.suspend(() => {
                commands++
                return Effect.fail(new Error("Connection interrupted."))
              }),
          }
        )
        yield* waitFor(actor, (s) => s.matches({ resource: "hidden" }))
        yield* send(actor, { type: "REFRESH" })
        yield* TestClock.adjust("15 seconds")
        expect(reads).toBe(0)
        yield* send(actor, { type: "VISIBILITY", visible: true })
        yield* waitFor(actor, (s) => s.matches({ resource: "waiting" }))
        expect(yield* browserCommand(actor, request("uncertain"))).toBe(false)
        yield* waitFor(actor, (s) => s.matches({ resource: "waiting" }))
        yield* TestClock.adjust("5 seconds")
        yield* waitFor(actor, (s) => s.matches({ resource: "waiting" }))
        expect(commands).toBe(1)
        expect(actor.getSnapshot().context.state).toEqual(uncertain)
        expect(actor.getSnapshot().context.error).toBe(
          "Connection interrupted."
        )
        expect(reads).toBe(3)
        yield* send(actor, { type: "VISIBILITY", visible: false })
        yield* waitFor(actor, (s) => s.matches({ resource: "hidden" }))
        yield* TestClock.adjust("15 seconds")
        expect(reads).toBe(3)
      }).pipe(Effect.scoped)
  )

  it.effect(
    "fences a late aborted refresh after a command has replaced its observation",
    () =>
      Effect.gen(function* () {
        let resolveRead!: (value: BrowserState) => void
        let signal: AbortSignal | undefined
        let reads = 0
        const started = yield* Deferred.make<void>()
        const actor = yield* makeBrowserOwner(view, {
          read: () =>
            ++reads === 1
              ? nativeOperation(
                  (observing) => {
                    signal = observing
                    Effect.runSync(Deferred.succeed(started, undefined))
                    return new Promise<BrowserState>((resolve) => {
                      resolveRead = resolve
                    })
                  },
                  (error) => error
                )
              : Effect.succeed(state(2)),
          command: () => Effect.succeed(state(2)),
        })
        yield* Deferred.await(started)
        expect(yield* browserCommand(actor, request("new-state"))).toBe(true)
        yield* waitFor(actor, (s) => s.matches({ resource: "waiting" }))
        expect(signal?.aborted).toBe(true)
        resolveRead(state(1))
        yield* Effect.yieldNow
        expect(actor.getSnapshot().context.state?.policy.generation).toBe(2)
      }).pipe(Effect.scoped)
  )

  it.effect(
    "explicit Close interrupts observation, fetches current generation and joins the old HTTP settlement",
    () =>
      Effect.gen(function* () {
        let release!: (response: Response) => void
        let openSignal: AbortSignal | undefined
        let closed = false
        const posts: { path: string; body: unknown }[] = []
        const entered = yield* Deferred.make<void>()
        vi.stubGlobal("fetch", (url: string, options: RequestInit) => {
          const path = new URL(url, "http://local").pathname
          if (options.method === "POST") {
            posts.push({ path, body: JSON.parse(options.body as string) })
            if (path.endsWith("/open")) {
              openSignal = options.signal as AbortSignal
              Effect.runSync(Deferred.succeed(entered, undefined))
              return new Promise<Response>((resolve) => {
                release = resolve
              })
            }
            closed = true
          }
          return Promise.resolve(
            Response.json({ ...state(9), status: closed ? "closed" : "ready" })
          )
        })
        const scope = yield* Scope.make()
        const actor = yield* makeBrowserOwner(
          view,
          browserRequests("one")
        ).pipe(Effect.provideService(Scope.Scope, scope))
        yield* waitFor(actor, (s) => s.matches({ resource: "waiting" }))
        const first = yield* browserCommand(actor, {
          ...request("open", "open"),
          body: { generation: 1, url: "https://example.com" },
        }).pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        const close = yield* browserCommand(actor, {
          ...request("close", "close"),
          interrupt: true,
        }).pipe(Effect.forkChild)
        expect(yield* Fiber.join(first)).toBe(false)
        expect(yield* Fiber.join(close)).toBe(true)
        yield* waitFor(actor, (s) => s.matches({ resource: "waiting" }))
        expect(openSignal?.aborted).toBe(true)
        expect(posts).toEqual([
          {
            path: "/api/agent/browser/open",
            body: { generation: 1, url: "https://example.com" },
          },
          { path: "/api/agent/browser/close", body: { generation: 9 } },
        ])
        expect(actor.getSnapshot().context.state?.status).toBe("closed")
        const disposing = yield* Scope.close(scope, Exit.void).pipe(
          Effect.forkChild
        )
        yield* Effect.yieldNow
        expect(disposing.pollUnsafe()).toBeUndefined()
        release(Response.json(state(1)))
        yield* Fiber.join(disposing)
        expect(actor.getSnapshot().context.state?.status).toBe("closed")
      })
  )

  it.effect(
    "closing the observer scope never sends remote Close and retains late compound cleanup failure",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const aborted = yield* Deferred.make<void>()
        let reject!: (cause: unknown) => void
        const commands: string[] = []
        const scope = yield* Scope.make()
        const actor = yield* makeBrowserOwner(view, {
          read: () => Effect.succeed(state()),
          command: (input) =>
            nativeOperation(
              (signal) => {
                commands.push(input.path)
                signal.addEventListener(
                  "abort",
                  () => Effect.runSync(Deferred.succeed(aborted, undefined)),
                  { once: true }
                )
                Effect.runSync(Deferred.succeed(entered, undefined))
                return new Promise<BrowserState>((_, fail) => {
                  reject = fail
                })
              },
              (error) => error
            ),
        }).pipe(Effect.provideService(Scope.Scope, scope))
        yield* waitFor(actor, (s) => s.matches({ resource: "waiting" }))
        const result = yield* browserCommand(actor, request("native")).pipe(
          Effect.forkChild
        )
        yield* Deferred.await(entered)
        const disposing = yield* Effect.exit(
          Scope.close(scope, Exit.void)
        ).pipe(Effect.forkChild)
        yield* Deferred.await(aborted)
        expect(disposing.pollUnsafe()).toBeUndefined()
        const defect = new Error("late native cleanup defect")
        class NativeRequest extends Context.Service<NativeRequest, string>()(
          "BrowserCleanupRequest"
        ) {}
        const annotations = Context.make(NativeRequest, "browser-native")
        reject(
          Cause.fromReasons([
            ...Cause.fail("late checked cleanup").reasons,
            Cause.makeDieReason(defect).annotate(annotations),
            Cause.makeInterruptReason(85234).annotate(annotations),
          ])
        )
        const exit = yield* Fiber.join(disposing)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(
            exit.cause.reasons.some(
              (reason) =>
                reason._tag === "Die" &&
                reason.defect === defect &&
                reason.annotations.get(NativeRequest.key) === "browser-native"
            )
          ).toBe(true)
          expect(
            exit.cause.reasons.some(
              (reason) =>
                reason._tag === "Interrupt" &&
                reason.fiberId === 85234 &&
                reason.annotations.get(NativeRequest.key) === "browser-native"
            )
          ).toBe(true)
          expect(
            exit.cause.reasons.some(
              (reason) =>
                reason._tag === "Die" &&
                typeof reason.defect === "object" &&
                reason.defect !== null &&
                "error" in reason.defect &&
                reason.defect.error === "late checked cleanup"
            )
          ).toBe(true)
        }
        expect(yield* Fiber.join(result)).toBe(false)
        expect(commands).toEqual(["interact"])
      })
  )
})

describe("Browser preview identity", () => {
  const original = {
    agentId: "one",
    generation: 1,
    version: 7,
    hasScreenshot: true,
  }
  it.effect(
    "requires the exact agent, generation and version load before enabling interaction",
    () =>
      Effect.gen(function* () {
        let refreshes = 0
        const actor = yield* createEffectActor(
          browserPreviewMachine(() =>
            Effect.sync(() => {
              refreshes++
            })
          ),
          { input: original }
        )
        yield* send(actor, { type: "LOADED", ...original })
        yield* waitFor(actor, (s) => s.matches("ready"))
        for (const next of [
          { ...original, agentId: "two" },
          { ...original, generation: 2 },
          { ...original, version: 8 },
        ]) {
          yield* send(actor, { type: "VIEW", ...next })
          yield* waitFor(actor, (s) => s.matches("loading"))
          yield* send(actor, { type: "LOADED", ...original })
          yield* send(actor, { type: "FAILED", ...original })
          yield* Effect.yieldNow
          expect(actor.getSnapshot().matches("loading")).toBe(true)
          expect(refreshes).toBe(0)
          yield* send(actor, { type: "LOADED", ...next })
          yield* waitFor(actor, (s) => s.matches("ready"))
        }
      }).pipe(Effect.scoped)
  )

  it.effect(
    "keeps failure attached to its screenshot and refreshes only once",
    () =>
      Effect.gen(function* () {
        let refreshes = 0
        const actor = yield* createEffectActor(
          browserPreviewMachine(() =>
            Effect.sync(() => {
              refreshes++
            })
          ),
          { input: original }
        )
        yield* send(actor, { type: "FAILED", ...original })
        yield* waitFor(actor, (s) => s.matches("failed"))
        yield* send(actor, { type: "FAILED", ...original })
        yield* send(actor, { type: "LOADED", ...original })
        yield* Effect.yieldNow
        expect(actor.getSnapshot().matches("failed")).toBe(true)
        expect(refreshes).toBe(1)
        const next = { ...original, agentId: "two" }
        yield* send(actor, { type: "VIEW", ...next })
        yield* waitFor(actor, (s) => s.matches("loading"))
        yield* send(actor, { type: "LOADED", ...next })
        yield* waitFor(actor, (s) => s.matches("ready"))
        yield* send(actor, { type: "VIEW", ...next, hasScreenshot: false })
        yield* waitFor(actor, (s) => s.matches("missing"))
        yield* send(actor, { type: "LOADED", ...next })
        yield* Effect.yieldNow
        expect(actor.getSnapshot().matches("missing")).toBe(true)
      }).pipe(Effect.scoped)
  )
})
