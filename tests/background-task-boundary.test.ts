import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import { createModels } from "@earendil-works/pi-ai"
import {
  Harness,
  createRegistry,
  type ConversationId,
} from "@earendil-works/pi-durable"
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory"
import { expect, it } from "@effect/vitest"
import { Cause, Clock, Context, Effect, Exit } from "effect"
import { TestClock } from "effect/testing"
import { it as test } from "vitest"

import {
  BackgroundDocument,
  piBackgroundLedger,
} from "../src/delegation/adapters/background-pi"
import {
  migrateBackgroundState,
  backgroundControlId,
  backgroundInitialId,
} from "../src/delegation/background-task-domain"
import { makeBackgroundTaskOwner } from "../src/delegation/background-task-owner"
import { advanceBackgroundTask } from "../src/delegation/background-task.machine"
import { makeBackgroundTasks } from "../src/delegation/background-tasks"
import { DelegationFailure, type Control } from "../src/delegation/contracts"
import { resolveRoute } from "../src/inference/policy"

const handoff = () => ({
  id: 97,
  parentObject: "parent",
  turnId: "turn",
  conversationId: 1,
  reportId: "report",
  route: {
    ...resolveRoute("conversation", { model: "gpt-6-luna", thinking: "low" }),
    contextWindow: 8192,
  },
  memory: "Private reference",
  input: {
    objective: "Draft",
    tasks: [{ name: "Draft", task: "Private text draft", tools: [] }],
  },
  createdAt: 0,
  deadline: 10000,
})
const authority = { authorized: () => Effect.succeed(true) }
const fixture = <T, TError, TRequirements>(
  body: (
    h: Harness,
    ledger: ReturnType<typeof piBackgroundLedger>
  ) => Effect.Effect<T, TError, TRequirements>
) =>
  Effect.acquireUseRelease(
    Effect.promise(() =>
      Harness.open(
        new MemoryStorage(),
        { models: createModels(), registry: createRegistry() },
        context
      )
    ),
    (h) =>
      body(
        h,
        piBackgroundLedger(async () => h, {
          submit: async (child, text, requestId, steer) =>
            (await h.conversation(child as ConversationId, context))!.submit(
              {
                type: "input",
                content: text,
                requestId,
                whenBusy: steer ? "steer" : "followUp",
              },
              context
            ),
          abort: async (child) =>
            (await h.conversation(child as ConversationId, context))!.abort(
              context
            ),
        })
      ),
    (h) => Effect.promise(() => h.close(context))
  )
const failedWith = <T, TError>(exit: Exit.Exit<T, TError>, code: string) =>
  Exit.isFailure(exit) &&
  exit.cause.reasons.some(
    (reason) =>
      reason._tag === "Fail" &&
      typeof reason.error === "object" &&
      reason.error !== null &&
      "code" in reason.error &&
      reason.error.code === code
  )

it.effect(
  "native background commits preserve invocation Context and Clock",
  () =>
    fixture((_h, ledger) =>
      Effect.gen(function* () {
        class Caller extends Context.Service<Caller, string>()(
          "BackgroundTaskCaller"
        ) {}
        yield* TestClock.adjust(1234)
        const result = yield* ledger
          .atomic((tx) =>
            Effect.gen(function* () {
              const memory = yield* Caller,
                at = yield* Clock.currentTimeMillis
              const pin = { ...handoff(), memory, createdAt: at }
              const child = yield* tx.createChild(pin, pin.input.tasks[0]!)
              ;(yield* tx.state()).value = migrateBackgroundState({
                handoff: pin,
                children: [{ ...child, requests: 0, stopped: false }],
                revision: 0,
                stopped: false,
                sealed: false,
                controls: [],
                applied: [],
              })
              return { memory, at }
            })
          )
          .pipe(Effect.provideService(Caller, "Invocation reference"))
        expect(result).toEqual({ memory: "Invocation reference", at: 1234 })
        expect((yield* ledger.state())?.handoff).toMatchObject({
          memory: "Invocation reference",
          createdAt: 1234,
        })
      })
    )
)

it.effect(
  "typed native rollback removes both child allocation and its state document",
  () =>
    fixture((h, ledger) =>
      Effect.gen(function* () {
        let allocated = 0
        const exit = yield* ledger
          .atomic((tx) =>
            Effect.gen(function* () {
              const pin = handoff(),
                child = yield* tx.createChild(pin, pin.input.tasks[0]!)
              allocated = child.id
              ;(yield* tx.state()).value = migrateBackgroundState({
                handoff: pin,
                children: [{ ...child, requests: 0, stopped: false }],
                revision: 0,
                stopped: false,
                sealed: false,
                controls: [],
                applied: [],
              })
              return yield* new DelegationFailure({
                code: "invalid",
                message: "Reject native admission",
              })
            })
          )
          .pipe(Effect.exit)
        expect(failedWith(exit, "invalid")).toBe(true)
        expect(yield* ledger.state()).toBeUndefined()
        expect(
          yield* Effect.promise(() =>
            h.conversation(allocated as ConversationId, context)
          )
        ).toBeUndefined()
      })
    )
)

it.effect(
  "request budget and deadline use native committed state and invocation Clock",
  () =>
    fixture((_h, ledger) =>
      Effect.gen(function* () {
        const app = makeBackgroundTasks(ledger, authority)
        yield* app.initialize(handoff())
        const provider = (yield* ledger.state())!.children[0]!.provider
        for (let index = 0; index < 12; index++) yield* app.request(provider)
        expect(
          failedWith(yield* app.request(provider).pipe(Effect.exit), "limit")
        ).toBe(true)
        expect((yield* ledger.state())!.children[0]!.requests).toBe(12)
        yield* TestClock.adjust(10000)
        yield* app.advance()
        expect((yield* ledger.state())?.authority).toBe("revoked")
        expect((yield* ledger.state())!.children[0]!.requests).toBe(12)
      })
    )
)

it.effect(
  "revoked parent authority fences provider requests and stops native children",
  () =>
    fixture((_h, ledger) =>
      Effect.gen(function* () {
        let allowed = true,
          aborts = 0
        const app = makeBackgroundTasks(
          {
            ...ledger,
            abort: (child) => {
              aborts++
              return ledger.abort(child)
            },
          },
          { authorized: () => Effect.sync(() => allowed) }
        )
        yield* app.initialize(handoff())
        allowed = false
        const provider = (yield* ledger.state())!.children[0]!.provider
        expect(
          failedWith(
            yield* app.request(provider).pipe(Effect.exit),
            "cancelled"
          )
        ).toBe(true)
        expect((yield* app.advance()).status).toBe("cancelled")
        expect(aborts).toBe(1)
        expect((yield* ledger.state())!.children[0]!.requests).toBe(0)
      })
    )
)

it.effect(
  "control identity, steering cap and child Stop survive native commit",
  () =>
    fixture((_h, ledger) =>
      Effect.gen(function* () {
        const app = makeBackgroundTasks(ledger, authority)
        yield* app.initialize(handoff())
        const child = (yield* ledger.state())!.children[0]!
        const first: Control = {
          groupId: 97,
          childId: child.id,
          operationId: crypto.randomUUID(),
          action: { type: "steer", text: "First steer" },
        }
        expect(yield* app.control(first)).toEqual({ accepted: true })
        expect(yield* app.control(first)).toEqual({ accepted: false })
        expect(
          failedWith(
            yield* app
              .control({ ...first, action: { type: "steer", text: "Changed" } })
              .pipe(Effect.exit),
            "conflict"
          )
        ).toBe(true)
        for (let index = 1; index < 8; index++)
          yield* app.control({ ...first, operationId: crypto.randomUUID() })
        expect(
          failedWith(
            yield* app
              .control({ ...first, operationId: crypto.randomUUID() })
              .pipe(Effect.exit),
            "limit"
          )
        ).toBe(true)
        yield* app.control({
          ...first,
          operationId: crypto.randomUUID(),
          action: { type: "stop" },
        })
        expect(
          failedWith(
            yield* app.request(child.provider).pipe(Effect.exit),
            "cancelled"
          )
        ).toBe(true)
        expect((yield* ledger.state())!.children[0]!.authority).toBe("revoked")
      })
    )
)

it.effect(
  "lost control acknowledgement replays one native submission before marking it applied",
  () =>
    fixture((h, ledger) =>
      Effect.gen(function* () {
        let lose = true
        const app = makeBackgroundTasks(
          {
            ...ledger,
            submit: (child, text, request, steer) =>
              ledger.submit(child, text, request, steer).pipe(
                Effect.andThen(
                  Effect.suspend(() => {
                    if (steer && lose) {
                      lose = false
                      return Effect.fail(
                        new DelegationFailure({
                          code: "unavailable",
                          message: "Lost acknowledgement",
                        })
                      )
                    }
                    return Effect.void
                  })
                )
              ),
          },
          authority
        )
        yield* app.initialize(handoff())
        const child = (yield* ledger.state())!.children[0]!
        yield* ledger.submit(
          child.id,
          handoff().input.tasks[0]!.task,
          backgroundInitialId(child.id),
          false
        )
        const input: Control = {
          groupId: 97,
          childId: child.id,
          operationId: crypto.randomUUID(),
          action: { type: "steer", text: "Use later constraints" },
        }
        expect(
          failedWith(yield* app.control(input).pipe(Effect.exit), "unavailable")
        ).toBe(true)
        const submission = () =>
          Effect.promise(() =>
            h.commit(
              (tx) =>
                tx.submissionByRequest(
                  child.id as ConversationId,
                  backgroundControlId(input)
                ),
              context
            )
          )
        const prior = yield* submission()
        expect(prior).toBeDefined()
        expect((yield* ledger.state())!.applied).toEqual([])
        expect(yield* app.control(input)).toEqual({ accepted: false })
        expect((yield* submission())?.id).toBe(prior?.id)
        expect((yield* ledger.state())!.applied).toEqual([input.operationId])
      })
    )
)

it.effect(
  "a concurrent control revision prevents sealing an obsolete projection",
  () =>
    fixture((_h, ledger) =>
      Effect.gen(function* () {
        let change = true
        const app = makeBackgroundTasks(
          {
            ...ledger,
            facts: (snapshot) =>
              Effect.gen(function* () {
                if (change) {
                  change = false
                  yield* ledger.atomic((tx) =>
                    Effect.gen(function* () {
                      const document = yield* tx.state(),
                        current = document.value!
                      document.value = advanceBackgroundTask(current, {
                        type: "CONTROL",
                        input: {
                          groupId: 97,
                          childId: current.children[0]!.id,
                          operationId: crypto.randomUUID(),
                          action: { type: "steer", text: "Later constraints" },
                        },
                        now: 0,
                      })
                    })
                  )
                }
                return snapshot.children.map(() => ({
                  inputs: [
                    { status: "done" as const },
                    ...snapshot.controls.map(() => undefined),
                  ],
                  answer: "Earlier answer",
                  inputTokens: null,
                  outputTokens: null,
                }))
              }),
          },
          authority
        )
        yield* app.initialize(handoff())
        expect((yield* app.advance()).status).toBe("working")
        expect((yield* ledger.state())!.outcome).toBe("working")
        expect((yield* ledger.state())!.controls).toHaveLength(1)
      })
    )
)

it.effect(
  "handoff and child identities cannot change through the native state view",
  () =>
    fixture((_h, ledger) =>
      Effect.gen(function* () {
        const app = makeBackgroundTasks(ledger, authority)
        yield* app.initialize(handoff())
        const before = yield* ledger.state()
        for (const mode of ["handoff", "child"]) {
          const exit = yield* ledger
            .atomic((tx) =>
              Effect.gen(function* () {
                const document = yield* tx.state(),
                  state = document.value!
                document.value =
                  mode === "handoff"
                    ? {
                        ...state,
                        handoff: { ...state.handoff, parentObject: "foreign" },
                      }
                    : {
                        ...state,
                        children: state.children.map((child) => ({
                          ...child,
                          id: child.id + 100,
                        })),
                      }
              })
            )
            .pipe(Effect.exit)
          expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
          expect(yield* ledger.state()).toEqual(before)
        }
      })
    )
)

it.effect("malformed and inconsistent stored documents remain defects", () =>
  fixture((h, ledger) =>
    Effect.gen(function* () {
      const app = makeBackgroundTasks(ledger, authority)
      yield* app.initialize(handoff())
      const state = (yield* ledger.state())!
      for (const raw of [
        "invalid-json",
        JSON.stringify({
          ...state,
          controls: [
            {
              groupId: 999,
              childId: state.children[0]!.id,
              operationId: crypto.randomUUID(),
              action: { type: "stop" },
            },
          ],
        }),
      ]) {
        yield* Effect.promise(() =>
          h.commit(async (tx) => {
            ;(await tx.doc(BackgroundDocument)).value = raw
          }, context)
        )
        const exit = yield* app.read().pipe(Effect.exit)
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
        expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
      }
    })
  )
)

it.effect(
  "rejects background tool grants and invalid transcript positions before native dispatch",
  () =>
    fixture((_h, ledger) =>
      Effect.gen(function* () {
        const app = makeBackgroundTasks(ledger, authority)
        const pin = handoff()
        expect(
          failedWith(
            yield* app
              .initialize({
                ...pin,
                input: {
                  ...pin.input,
                  tasks: pin.input.tasks.map((task) => ({
                    ...task,
                    tools: ["zoom"],
                  })),
                },
              })
              .pipe(Effect.exit),
            "invalid"
          )
        ).toBe(true)
        expect(yield* ledger.state()).toBeUndefined()
        expect(
          failedWith(
            yield* app
              .control({ groupId: "invalid", operationId: "private" })
              .pipe(Effect.exit),
            "invalid"
          )
        ).toBe(true)
        yield* app.initialize(pin)
        const child = (yield* ledger.state())!.children[0]!
        expect(
          failedWith(
            yield* app.transcript(child.id, "0").pipe(Effect.exit),
            "invalid"
          )
        ).toBe(true)
        expect(
          failedWith(
            yield* app.transcript(child.id + 100).pipe(Effect.exit),
            "not_found"
          )
        ).toBe(true)
      })
    )
)

test("already cancelled initialization allocates no durable background state", async () => {
  await Effect.runPromise(
    fixture((_h, ledger) =>
      Effect.promise(async () => {
        const controller = new AbortController()
        controller.abort()
        const app = makeBackgroundTasks(ledger, authority)
        const exit = await Effect.runPromiseExit(app.initialize(handoff()), {
          signal: controller.signal,
        })
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(
          true
        )
        expect(await Effect.runPromise(ledger.state())).toBeUndefined()
      })
    )
  )
})

// Stop revokes immediately but joins an already owned native admission before acknowledging cleanup.
test.each(["held-dispatch", "stop-first"] as const)(
  "remote native dispatch and Stop retain one owner: %s",
  async (ordering) => {
    await Effect.runPromise(
      fixture((h) =>
        Effect.promise(async () => {
          let markEntered!: () => void
          let releaseSubmit!: () => void
          const entered = new Promise<void>((resolve) => {
            markEntered = resolve
          })
          const held = new Promise<void>((resolve) => {
            releaseSubmit = resolve
          })
          const trace: string[] = []
          const owner = makeBackgroundTaskOwner()
          let markRevoked!: () => void
          const revoked = new Promise<void>((resolve) => {
            markRevoked = resolve
          })
          const ledger = piBackgroundLedger(async () => h, {
            submit: async (child, text, requestId, steer) => {
              const conversation = (await h.conversation(
                child as ConversationId,
                context
              ))!
              // This barrier is inside the actual native bridge, after all
              // BackgroundTasks state/authority reads and before Pi admission.
              trace.push("bridge-entered")
              markEntered()
              await held
              trace.push("native-submit-called")
              const receipt = await conversation.submit(
                {
                  type: "input",
                  content: text,
                  requestId,
                  whenBusy: steer ? "steer" : "followUp",
                },
                context
              )
              trace.push("native-submit-accepted")
              return receipt
            },
            abort: async (child) => {
              await (await h.conversation(
                child as ConversationId,
                context
              ))!.abort(context)
              trace.push("native-abort-joined")
            },
          })
          const app = makeBackgroundTasks(
            {
              ...ledger,
              atomic: (body) =>
                ledger.atomic(body).pipe(
                  Effect.tap(() =>
                    ledger.state().pipe(
                      Effect.tap((state) =>
                        Effect.sync(() => {
                          if (state?.authority === "revoked") markRevoked()
                        })
                      )
                    )
                  )
                ),
            },
            authority,
            Effect.succeed(0),
            owner
          )
          await Effect.runPromise(app.initialize(handoff()))
          const initial = (await Effect.runPromise(ledger.state()))!
          const child = initial.children[0]!
          const requestId = backgroundInitialId(child.id)
          const nativeSubmission = () =>
            h.commit(
              (tx) =>
                tx.submissionByRequest(child.id as ConversationId, requestId),
              context
            )
          let advancing: Promise<unknown> | undefined
          try {
            if (ordering === "stop-first") {
              await Effect.runPromise(app.stop())
              trace.push("stop-returned")
              advancing = Effect.runPromise(app.advance())
              await advancing
              expect(trace).not.toContain("bridge-entered")
              expect(trace).not.toContain("native-submit-called")
              expect(await nativeSubmission()).toBeUndefined()
            } else {
              advancing = Effect.runPromise(app.advance())
              await Promise.race([
                entered,
                advancing.then(() => {
                  throw new Error(
                    "Advance finished before entering held submit"
                  )
                }),
              ])
              expect(await nativeSubmission()).toBeUndefined()
              const stopping = Effect.runPromise(app.stop()).then(() => {
                trace.push("stop-returned")
              })
              await revoked
              expect(await Effect.runPromise(owner.available)).toBe(false)
              expect((await Effect.runPromise(ledger.state()))!.authority).toBe(
                "revoked"
              )
              expect(trace).toEqual(["bridge-entered"])
              expect(await nativeSubmission()).toBeUndefined()
              releaseSubmit()
              await Promise.all([advancing, stopping])
              expect(await nativeSubmission()).toMatchObject({
                requestId,
                type: "input",
              })
              expect(trace).toEqual([
                "bridge-entered",
                "native-submit-called",
                "native-submit-accepted",
                "native-abort-joined",
                "stop-returned",
              ])
              expect(
                (await Effect.runPromise(ledger.state()))!.children[0]!.stop
              ).toBe("confirmed")
            }
            const final = (await Effect.runPromise(ledger.state()))!
            expect(final.authority).toBe("revoked")
            expect(final.children[0]!.id).toBe(child.id)
            expect(final.children[0]!.provider).toBe(child.provider)
            expect(final.children[0]!.requests).toBe(0)
          } finally {
            // Release and join the in-flight call before fixture closes Pi,
            // including on an assertion failure. The original failure escapes.
            releaseSubmit()
            if (advancing) await advancing.catch(() => undefined)
          }
        })
      )
    )
  }
)

test("Stop while steering checks its native predecessor denies the stale dispatch", async () => {
  await Effect.runPromise(
    fixture((h, ledger) =>
      Effect.promise(async () => {
        let entered!: () => void, release!: () => void
        const checking = new Promise<void>((resolve) => {
          entered = resolve
        })
        const hold = new Promise<void>((resolve) => {
          release = resolve
        })
        const submitted: string[] = []
        const owner = makeBackgroundTaskOwner()
        let markRevoked!: () => void
        const revoked = new Promise<void>((resolve) => {
          markRevoked = resolve
        })
        const app = makeBackgroundTasks(
          {
            ...ledger,
            atomic: (body) =>
              ledger.atomic(body).pipe(
                Effect.tap(() =>
                  ledger.state().pipe(
                    Effect.tap((state) =>
                      Effect.sync(() => {
                        if (state?.authority === "revoked") markRevoked()
                      })
                    )
                  )
                )
              ),
            hasSubmission: (child, request) =>
              ledger.hasSubmission(child, request).pipe(
                Effect.flatMap((found) =>
                  Effect.promise(async () => {
                    entered()
                    await hold
                    return found
                  })
                )
              ),
            submit: (child, text, request, steer) =>
              Effect.sync(() => submitted.push(request)).pipe(
                Effect.andThen(ledger.submit(child, text, request, steer))
              ),
          },
          authority,
          Effect.succeed(0),
          owner
        )
        await Effect.runPromise(app.initialize(handoff()))
        const child = (await Effect.runPromise(ledger.state()))!.children[0]!
        await Effect.runPromise(
          ledger.submit(
            child.id,
            handoff().input.tasks[0]!.task,
            backgroundInitialId(child.id),
            false
          )
        )
        const input: Control = {
          groupId: 97,
          childId: child.id,
          operationId: crypto.randomUUID(),
          action: { type: "steer", text: "Must not launch after Stop" },
        }
        const steering = Effect.runPromise(app.control(input))
        let stopping: Promise<void> | undefined
        try {
          await checking
          stopping = Effect.runPromise(app.stop())
          await revoked
          expect(await Effect.runPromise(owner.available)).toBe(false)
          expect((await Effect.runPromise(ledger.state()))!.authority).toBe(
            "revoked"
          )
          release()
          await Promise.all([steering, stopping])
          expect(submitted).toEqual([])
          expect(
            await h.commit(
              (tx) =>
                tx.submissionByRequest(
                  child.id as ConversationId,
                  backgroundControlId(input)
                ),
              context
            )
          ).toBeUndefined()
          expect(
            (await Effect.runPromise(ledger.state()))!.applied
          ).not.toContain(input.operationId)
          expect(
            (await Effect.runPromise(ledger.state()))!.children[0]!.stop
          ).toBe("confirmed")
        } finally {
          release()
          await Promise.allSettled([steering, ...(stopping ? [stopping] : [])])
        }
      })
    )
  )
})

it.effect(
  "native Stop failure retains revoked authority and an explicit retryable obligation",
  () =>
    fixture((_h, ledger) =>
      Effect.gen(function* () {
        let unavailable = true
        const app = makeBackgroundTasks(
          {
            ...ledger,
            abort: (child) =>
              unavailable
                ? Effect.fail(
                    new DelegationFailure({
                      code: "unavailable",
                      message: "Lost native Stop acknowledgement",
                    })
                  )
                : ledger.abort(child),
          },
          authority
        )
        yield* app.initialize(handoff())
        const child = (yield* ledger.state())!.children[0]!
        expect(
          failedWith(yield* app.stop().pipe(Effect.exit), "unavailable")
        ).toBe(true)
        expect((yield* ledger.state())!.children[0]).toMatchObject({
          id: child.id,
          provider: child.provider,
          authority: "revoked",
          stop: "unconfirmed",
          stopAttempt: 1,
        })
        expect((yield* app.read()).children[0]).toMatchObject({
          status: "stopping",
          error:
            "Native Stop remains unconfirmed. Retry Stop to reconcile cleanup.",
        })
        expect(
          failedWith(
            yield* app.request(child.provider).pipe(Effect.exit),
            "cancelled"
          )
        ).toBe(true)
        unavailable = false
        yield* app.stop()
        expect((yield* ledger.state())!.children[0]).toMatchObject({
          id: child.id,
          authority: "revoked",
          stop: "confirmed",
          stopAttempt: 2,
        })
      })
    )
)

it.effect(
  "deadline crossing during native observation joins newly required cleanup",
  () =>
    fixture((_h, ledger) =>
      Effect.gen(function* () {
        let at = 0
        const aborted: number[] = []
        const app = makeBackgroundTasks(
          {
            ...ledger,
            facts: (state) =>
              ledger.facts(state).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    at = handoff().deadline
                  })
                )
              ),
            abort: (child) =>
              ledger.abort(child).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    aborted.push(child)
                  })
                )
              ),
          },
          authority,
          Effect.sync(() => at)
        )
        yield* app.initialize(handoff())
        const child = (yield* ledger.state())!.children[0]!
        yield* app.advance()
        expect(aborted).toEqual([child.id])
        expect(yield* ledger.state()).toMatchObject({
          outcome: "cancelled",
          authority: "revoked",
          children: [
            {
              id: child.id,
              authority: "revoked",
              stop: "confirmed",
              stopAttempt: 1,
            },
          ],
        })
      })
    )
)
