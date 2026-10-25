import { it } from "@effect/vitest"
import { send, waitFor } from "@xstate/effect"
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Schema,
  Scope,
} from "effect"
import { afterEach, expect, vi } from "vitest"

import { makeMailboxControlOwner } from "../src/features/activity/mailbox-control-owner"
import { MailboxControlView } from "../src/features/activity/mailbox-control.machine"
import {
  makeTaskControlOwner,
  taskCommandKey,
  taskControlRequests,
} from "../src/features/activity/task-control-owner"
import type {
  TaskCommand,
  TaskControlView,
} from "../src/features/activity/task-control.machine"

const id = "00000000-0000-4000-8000-000000000071"
const second = "00000000-0000-4000-8000-000000000072"
const view: TaskControlView = {
  agentId: "one",
  groupId: 17,
  childId: null,
  prefix: "background",
  active: ["stop", "retry"],
}
function storage() {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
}
const submit = (
  actor: Parameters<typeof send>[0],
  action: "stop" | "retry" | "steer",
  owner = view,
  text = ""
) => send(actor, { type: "SUBMIT", view: owner, action, text } as never)
afterEach(() => vi.unstubAllGlobals())

it.effect(
  "same-task duplicate admission creates one operation and serializes conflicting controls",
  () =>
    Effect.gen(function* () {
      const saved = storage(),
        release = yield* Deferred.make<void>(),
        started = yield* Deferred.make<void>()
      let ids = 0,
        posts = 0
      const work = taskControlRequests(saved, () => {
        ids++
        return id
      })
      const actor = yield* makeTaskControlOwner(view, {
        ...work,
        submit: () => {
          posts++
          return Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release))
          )
        },
      })
      yield* waitFor(actor, (s) => s.matches("ready"))
      yield* submit(actor, "retry")
      yield* submit(actor, "retry")
      yield* submit(actor, "stop")
      yield* Deferred.await(started)
      expect(ids).toBe(1)
      expect(posts).toBe(1)
      expect(JSON.parse(saved.getItem(taskCommandKey(view, "retry"))!)).toEqual(
        { groupId: 17, operationId: id, action: "retry" }
      )
      yield* Deferred.succeed(release, undefined)
    }).pipe(Effect.scoped)
)

it.effect(
  "restoration retains the legacy operation and never submits until explicit recovery",
  () =>
    Effect.gen(function* () {
      const saved = storage(),
        posts: unknown[] = []
      saved.setItem(
        taskCommandKey(view, "stop"),
        JSON.stringify({ groupId: 17, operationId: id, action: "stop" })
      )
      vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
        posts.push({ url, body: JSON.parse(init.body as string) })
        return Promise.resolve(
          Response.json(
            { error: "Acknowledgement unavailable" },
            { status: 503 }
          )
        )
      })
      const actor = yield* makeTaskControlOwner(
        { ...view, active: [] },
        taskControlRequests(saved, () => {
          throw new Error("No new operation allowed")
        })
      )
      yield* waitFor(actor, (s) => s.matches("ready"))
      expect(posts).toEqual([])
      yield* submit(actor, "retry")
      yield* Effect.yieldNow
      expect(posts).toEqual([])
      yield* submit(actor, "stop", { ...view, active: [] })
      yield* waitFor(actor, (s) => s.matches("ready") && !!s.context.error)
      expect(posts).toEqual([
        {
          url: "/api/agent/background/stop?agent=one",
          body: { groupId: 17, operationId: id },
        },
      ])
      expect(actor.getSnapshot().context.saved[0]?.body.operationId).toBe(id)
      expect(saved.getItem(taskCommandKey(view, "stop"))).toContain(id)
    }).pipe(Effect.scoped)
)

it.effect(
  "saved child steering keeps its original text across explicit retry",
  () =>
    Effect.gen(function* () {
      const child = {
          ...view,
          childId: 19,
          active: ["stop", "steer"] as const,
        },
        saved = storage(),
        posts: unknown[] = []
      const body = {
        groupId: 17,
        childId: 19,
        operationId: id,
        action: { type: "steer", text: "Original immutable steering" },
      }
      saved.setItem(taskCommandKey(child, "steer"), JSON.stringify(body))
      vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
        posts.push(JSON.parse(init.body as string))
        return Promise.resolve(Response.json({ ok: true }))
      })
      const actor = yield* makeTaskControlOwner(
        child,
        taskControlRequests(saved)
      )
      yield* waitFor(actor, (s) => s.matches("ready"))
      expect(posts).toEqual([])
      yield* submit(actor, "steer", child, "Changed text")
      yield* waitFor(actor, (s) => s.context.acknowledged !== null)
      expect(posts).toEqual([body])
      expect(saved.values.size).toBe(0)
    }).pipe(Effect.scoped)
)

it.effect(
  "malformed, future and mismatched saved controls fail closed without deleting recovery",
  () =>
    Effect.gen(function* () {
      for (const record of [
        "{",
        JSON.stringify({
          schemaVersion: 2,
          groupId: 17,
          operationId: id,
          action: "retry",
        }),
        JSON.stringify({ groupId: 99, operationId: id, action: "retry" }),
      ]) {
        const saved = storage()
        saved.setItem(taskCommandKey(view, "retry"), record)
        const actor = yield* makeTaskControlOwner(
          view,
          taskControlRequests(saved, () => {
            throw new Error("must not create")
          })
        )
        yield* waitFor(actor, (s) => s.matches("blocked"))
        yield* submit(actor, "retry")
        yield* Effect.yieldNow
        expect(saved.getItem(taskCommandKey(view, "retry"))).toBe(record)
        expect(actor.getSnapshot().context.error).toContain("retained")
      }
    }).pipe(Effect.scoped)
)

it.effect("a late acknowledgement cannot remove a newer saved operation", () =>
  Effect.gen(function* () {
    const saved = storage(),
      started = yield* Deferred.make<void>()
    let resolve!: (response: Response) => void
    vi.stubGlobal(
      "fetch",
      () =>
        new Promise<Response>((done) => {
          resolve = done
          Effect.runSync(Deferred.succeed(started, undefined))
        })
    )
    const actor = yield* makeTaskControlOwner(
      view,
      taskControlRequests(saved, () => id)
    )
    yield* waitFor(actor, (s) => s.matches("ready"))
    yield* submit(actor, "retry")
    yield* Deferred.await(started)
    const newer = { groupId: 17, operationId: second, action: "retry" }
    saved.setItem(taskCommandKey(view, "retry"), JSON.stringify(newer))
    resolve(Response.json({ ok: true }))
    yield* waitFor(actor, (s) => s.context.acknowledged !== null)
    expect(JSON.parse(saved.getItem(taskCommandKey(view, "retry"))!)).toEqual(
      newer
    )
  }).pipe(Effect.scoped)
)

it.effect(
  "revocation before prepared dispatch retains identity without sending",
  () =>
    Effect.gen(function* () {
      const saved = storage(),
        release = yield* Deferred.make<TaskCommand>()
      let posts = 0
      const work = taskControlRequests(saved)
      const actor = yield* makeTaskControlOwner(view, {
        ...work,
        prepare: () => Deferred.await(release),
        submit: () =>
          Effect.sync(() => {
            posts++
          }),
      })
      yield* waitFor(actor, (s) => s.matches("ready"))
      yield* submit(actor, "retry")
      yield* waitFor(actor, (s) => s.matches("preparing"))
      yield* send(actor, { type: "VIEW", ...view, active: [] })
      yield* waitFor(actor, (s) => s.context.view.active.length === 0)
      yield* Deferred.succeed(release, {
        kind: "background",
        body: { groupId: 17, operationId: id, action: "retry" },
      })
      yield* waitFor(actor, (s) => s.matches("ready"))
      expect(posts).toBe(0)
      expect(actor.getSnapshot().context.saved[0]?.body.operationId).toBe(id)
    }).pipe(Effect.scoped)
)

it.effect(
  "invalid intent or a different agent cannot authorize a task control",
  () =>
    Effect.gen(function* () {
      const saved = storage(),
        work = taskControlRequests(saved, () => {
          throw new Error("must not prepare")
        })
      const actor = yield* makeTaskControlOwner(view, work)
      yield* waitFor(actor, (s) => s.matches("ready"))
      yield* submit(actor, "stop", { ...view, agentId: "other" })
      yield* send(actor, { type: "SUBMIT", view, action: 3, text: "" } as never)
      yield* submit(actor, "steer", view, "wrong kind")
      yield* Effect.yieldNow
      expect(saved.values.size).toBe(0)
    }).pipe(Effect.scoped)
)

it.effect(
  "closing joins native settlement, preserves saved identity and retains the complete annotated cleanup",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make(),
        saved = storage(),
        started = yield* Deferred.make<void>(),
        aborted = yield* Deferred.make<void>()
      let reject!: (cause: unknown) => void
      vi.stubGlobal(
        "fetch",
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_, fail) => {
            reject = fail
            init.signal!.addEventListener("abort", () =>
              Effect.runSync(Deferred.succeed(aborted, undefined))
            )
            Effect.runSync(Deferred.succeed(started, undefined))
          })
      )
      const actor = yield* makeTaskControlOwner(
        view,
        taskControlRequests(saved, () => id)
      ).pipe(Scope.provide(scope))
      yield* waitFor(actor, (s) => s.matches("ready"))
      yield* submit(actor, "retry")
      yield* Deferred.await(started)
      const closing = yield* Effect.forkChild(
        Effect.exit(Scope.close(scope, Exit.void))
      )
      yield* Deferred.await(aborted)
      expect(closing.pollUnsafe()).toBeUndefined()
      const annotations = Context.makeUnsafe(
        new Map([["activity-control", "kept"]])
      )
      const checked = new Error("checked"),
        defect = new Error("cleanup")
      reject(
        Cause.fromReasons([
          Cause.makeFailReason(checked).annotate(annotations),
          Cause.makeDieReason(defect).annotate(annotations),
          Cause.makeInterruptReason(714).annotate(annotations),
        ])
      )
      const exit = yield* Fiber.join(closing)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(
          exit.cause.reasons.some(
            (r) =>
              r._tag === "Die" &&
              r.defect === defect &&
              r.annotations.get("activity-control") === "kept"
          )
        ).toBe(true)
        expect(
          exit.cause.reasons.some(
            (r) =>
              r._tag === "Interrupt" &&
              r.fiberId === 714 &&
              r.annotations.get("activity-control") === "kept"
          )
        ).toBe(true)
        expect(
          exit.cause.reasons.some(
            (r) =>
              r._tag === "Die" &&
              Cause.isReason(r.defect) &&
              Cause.isFailReason(r.defect) &&
              r.defect.error === checked &&
              r.defect.annotations.get("activity-control") === "kept"
          )
        ).toBe(true)
      }
      expect(saved.getItem(taskCommandKey(view, "retry"))).toContain(id)
    })
)

const mailbox = (epoch: string): MailboxControlView => ({
  agentId: "one",
  state: {
    tasks: [],
    deliveries: [],
    recovery: {
      schemaVersion: 1,
      workflowVersion: 1,
      epoch,
      failedAt: 1,
      discoveryToken: null,
      message: "Mailbox needs attention",
    },
  },
})
it.effect(
  "mailbox duplicate controls serialize and an old acknowledgement retains a newer recovery epoch",
  () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>(),
        seen: string[] = []
      const initial = mailbox("old")
      const actor = yield* makeMailboxControlOwner(
        initial,
        (_view, request) => {
          seen.push(request.id)
          return Deferred.await(release)
        }
      )
      yield* send(actor, {
        type: "SUBMIT",
        agentId: "one",
        id: "old",
        action: "retry_mailbox",
      })
      yield* send(actor, {
        type: "SUBMIT",
        agentId: "one",
        id: "old",
        action: "retry_mailbox",
      })
      yield* waitFor(actor, (s) => s.matches("submitting"))
      yield* send(actor, { type: "VIEW", ...mailbox("new") })
      yield* waitFor(
        actor,
        (s) => s.context.view.state?.recovery?.epoch === "new"
      )
      yield* Deferred.succeed(release, undefined)
      yield* waitFor(actor, (s) => s.matches("ready"))
      expect(seen).toEqual(["old"])
      expect(actor.getSnapshot().context.view.state?.recovery?.epoch).toBe(
        "new"
      )
      yield* send(actor, {
        type: "SUBMIT",
        agentId: "one",
        id: "old",
        action: "retry_mailbox",
      })
      yield* send(actor, {
        type: "SUBMIT",
        agentId: "other",
        id: "new",
        action: "retry_mailbox",
      })
      yield* send(actor, {
        type: "SUBMIT",
        agentId: "one",
        id: "new",
        action: 9,
      } as never)
      yield* Effect.yieldNow
      expect(seen).toEqual(["old"])
    }).pipe(Effect.scoped)
)
it.effect(
  "mailbox uncertainty permits only explicit retry of the same epoch",
  () =>
    Effect.gen(function* () {
      const seen: string[] = []
      const actor = yield* makeMailboxControlOwner(
        mailbox("old"),
        (_view, request) => {
          seen.push(request.id)
          return Effect.fail(new Error("No acknowledgement"))
        }
      )
      yield* send(actor, {
        type: "SUBMIT",
        agentId: "one",
        id: "old",
        action: "retry_mailbox",
      })
      yield* waitFor(actor, (s) => s.matches("uncertain"))
      yield* send(actor, {
        type: "SUBMIT",
        agentId: "one",
        id: "different",
        action: "retry_mailbox",
      })
      yield* Effect.yieldNow
      expect(seen).toEqual(["old"])
      yield* send(actor, {
        type: "SUBMIT",
        agentId: "one",
        id: "old",
        action: "retry_mailbox",
      })
      yield* waitFor(actor, (s) => s.matches("uncertain") && seen.length === 2)
      expect(seen).toEqual(["old", "old"])
    }).pipe(Effect.scoped)
)

it.effect(
  "a stale mailbox rejection remains visible without clearing a newer recovery",
  () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void, Error>()
      const actor = yield* makeMailboxControlOwner(mailbox("old"), () =>
        Deferred.await(release)
      )
      yield* send(actor, {
        type: "SUBMIT",
        agentId: "one",
        id: "old",
        action: "retry_mailbox",
      })
      yield* waitFor(actor, (s) => s.matches("submitting"))
      yield* send(actor, { type: "VIEW", ...mailbox("new") })
      yield* waitFor(
        actor,
        (s) => s.context.view.state?.recovery?.epoch === "new"
      )
      yield* Deferred.fail(
        release,
        new Error("This mailbox recovery is no longer current.")
      )
      yield* waitFor(actor, (s) => s.matches("ready"))
      expect(actor.getSnapshot().context.error).toBe(
        "This mailbox recovery is no longer current."
      )
      expect(actor.getSnapshot().context.view.state?.recovery?.epoch).toBe(
        "new"
      )
    }).pipe(Effect.scoped)
)

it.effect(
  "explicit Stop after uncertain steering preserves both immutable operation identities",
  () =>
    Effect.gen(function* () {
      const child = {
          ...view,
          childId: 19,
          active: ["stop", "steer"] as const,
        },
        saved = storage(),
        posts: unknown[] = []
      let generated = 0
      vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
        posts.push(JSON.parse(init.body as string))
        return Promise.resolve(
          posts.length === 1
            ? Response.json(
                { error: "Steer acknowledgement lost" },
                { status: 503 }
              )
            : Response.json({ ok: true })
        )
      })
      const actor = yield* makeTaskControlOwner(
        child,
        taskControlRequests(saved, () => (++generated === 1 ? id : second))
      )
      yield* waitFor(actor, (s) => s.matches("ready"))
      yield* submit(actor, "steer", child, "Immutable original brief")
      yield* waitFor(actor, (s) => s.matches("ready") && !!s.context.error)
      yield* submit(actor, "stop", child)
      yield* waitFor(actor, (s) => s.context.acknowledged !== null)
      expect(posts).toEqual([
        {
          groupId: 17,
          childId: 19,
          operationId: id,
          action: { type: "steer", text: "Immutable original brief" },
        },
        {
          groupId: 17,
          childId: 19,
          operationId: second,
          action: { type: "stop" },
        },
      ])
      expect(saved.getItem(taskCommandKey(child, "steer"))).toContain(id)
      expect(saved.getItem(taskCommandKey(child, "stop"))).toBeNull()
      expect(
        actor
          .getSnapshot()
          .context.saved.map((command) => command.body.operationId)
      ).toEqual([id])
    }).pipe(Effect.scoped)
)

it.effect(
  "explicit cancellation after uncertain mailbox recovery sends the new exact task identity",
  () =>
    Effect.gen(function* () {
      const initial = mailbox("old")
      const task = {
        id: "cancel-me",
        direction: "outgoing" as const,
        request: {
          version: 1 as const,
          id: "request",
          owner: "owner",
          from: "home",
          to: "00000000-0000-4000-8000-000000000071",
          taskId: "cancel-me",
          correlationId: "turn",
          causationId: "turn",
          createdAt: 1,
          deadline: 9e12,
          depth: 0,
          payload: {
            kind: "task" as const,
            objective: "Pending task",
            context: "",
          },
        },
        status: "waiting" as const,
        outcome: null,
        revision: 1,
        leaseUntil: null,
        resumed: false,
        cancelRequested: false,
        schemaVersion: 1 as const,
        workflowVersion: 1 as const,
        control: {
          owner: null,
          phase: "observe" as const,
          deadline: null,
          attempts: 0,
          unconfirmed: false,
        },
        stop: {
          status: "none" as const,
          attempts: 0,
          deadline: null,
          nextAt: null,
        },
      }
      const current = Schema.decodeUnknownSync(MailboxControlView)({
        ...initial,
        state: { ...initial.state!, tasks: [task] },
      })
      const seen: unknown[] = []
      const actor = yield* makeMailboxControlOwner(
        current,
        (_view, request) => {
          seen.push(request)
          return seen.length === 1
            ? Effect.fail(new Error("Recovery acknowledgement lost"))
            : Effect.void
        }
      )
      yield* send(actor, {
        type: "SUBMIT",
        agentId: "one",
        id: "old",
        action: "retry_mailbox",
      })
      yield* waitFor(actor, (s) => s.matches("uncertain"))
      yield* send(actor, {
        type: "SUBMIT",
        agentId: "one",
        id: "cancel-me",
        action: "cancel",
      })
      yield* waitFor(actor, (s) => s.matches("ready"))
      expect(seen).toEqual([
        { id: "old", action: "retry_mailbox" },
        { id: "cancel-me", action: "cancel" },
      ])
      expect(actor.getSnapshot().context.view.state?.tasks[0]?.status).toBe(
        "waiting"
      )
      expect(
        actor.getSnapshot().context.view.state?.tasks[0]?.cancelRequested
      ).toBe(false)
    }).pipe(Effect.scoped)
)

for (const kind of ["task", "mailbox"] as const) {
  for (const withDefect of [false, true]) {
    it.effect(
      `naturally settled ${kind} failure retains its annotated checked and interrupt reasons${withDefect ? " and defect" : ""} on close`,
      () =>
        Effect.gen(function* () {
          const scope = yield* Scope.make()
          const saved = storage()
          const annotations = Context.makeUnsafe(
            new Map([["activity-control-settled", "kept"]])
          )
          const checked = new Error("request failure"),
            defect = new Error("native cleanup failure")
          const cause = Cause.fromReasons([
            Cause.makeFailReason(checked).annotate(annotations),
            ...(withDefect
              ? [Cause.makeDieReason(defect).annotate(annotations)]
              : []),
            Cause.makeInterruptReason(714).annotate(annotations),
          ])
          let posts = 0
          vi.stubGlobal("fetch", () => {
            posts++
            return Promise.reject(cause)
          })
          if (kind === "task") {
            const actor = yield* makeTaskControlOwner(
              view,
              taskControlRequests(saved, () => id)
            ).pipe(Scope.provide(scope))
            yield* waitFor(actor, (s) => s.matches("ready"))
            yield* submit(actor, "retry")
            yield* waitFor(
              actor,
              (s) => s.matches("ready") && Cause.isCause(s.context.failure)
            )
            expect(saved.getItem(taskCommandKey(view, "retry"))).toContain(id)
          } else {
            const actor = yield* makeMailboxControlOwner(mailbox("old")).pipe(
              Scope.provide(scope)
            )
            yield* send(actor, {
              type: "SUBMIT",
              agentId: "one",
              id: "old",
              action: "retry_mailbox",
            })
            yield* waitFor(actor, (s) => s.matches("uncertain"))
          }
          expect(posts).toBe(1)
          const exit = yield* Effect.exit(Scope.close(scope, Exit.void))
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            expect(
              exit.cause.reasons.some(
                (reason) =>
                  reason._tag === "Die" &&
                  Cause.isReason(reason.defect) &&
                  Cause.isFailReason(reason.defect) &&
                  reason.defect.error === checked &&
                  reason.defect.annotations.get("activity-control-settled") ===
                    "kept"
              )
            ).toBe(true)
            expect(
              exit.cause.reasons.some(
                (reason) =>
                  reason._tag === "Interrupt" &&
                  reason.fiberId === 714 &&
                  reason.annotations.get("activity-control-settled") === "kept"
              )
            ).toBe(true)
            if (withDefect)
              expect(
                exit.cause.reasons.some(
                  (reason) =>
                    reason._tag === "Die" &&
                    reason.defect === defect &&
                    reason.annotations.get("activity-control-settled") ===
                      "kept"
                )
              ).toBe(true)
          }
          expect(posts).toBe(1)
        })
    )
  }
}
