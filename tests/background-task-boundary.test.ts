import { expect, it } from "@effect/vitest"
import { it as test } from "vitest"
import { Cause, Clock, Context, Effect, Exit } from "effect"
import { TestClock } from "effect/testing"
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import {
  Harness,
  createRegistry,
  type ConversationId,
} from "@earendil-works/pi-durable"
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory"
import { createModels } from "@earendil-works/pi-ai"
import {
  BackgroundDocument,
  piBackgroundLedger,
} from "../src/delegation/adapters/background-pi"
import { makeBackgroundTasks } from "../src/delegation/background-tasks"
import {
  acceptBackgroundControl,
  backgroundControlId,
} from "../src/delegation/background-task-domain"
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
              ;(yield* tx.state()).value = {
                handoff: pin,
                children: [{ ...child, requests: 0, stopped: false }],
                revision: 0,
                stopped: false,
                sealed: false,
                controls: [],
                applied: [],
              }
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
              ;(yield* tx.state()).value = {
                handoff: pin,
                children: [{ ...child, requests: 0, stopped: false }],
                revision: 0,
                stopped: false,
                sealed: false,
                controls: [],
                applied: [],
              }
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
        expect((yield* ledger.state())?.stopped).toBe(true)
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
        expect((yield* ledger.state())!.children[0]!.stopped).toBe(true)
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
        yield* app.advance()
        const child = (yield* ledger.state())!.children[0]!
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
                      document.value = acceptBackgroundControl(
                        current,
                        {
                          groupId: 97,
                          childId: current.children[0]!.id,
                          operationId: crypto.randomUUID(),
                          action: { type: "steer", text: "Later constraints" },
                        },
                        0
                      )
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
        expect((yield* ledger.state())!.sealed).toBe(false)
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
