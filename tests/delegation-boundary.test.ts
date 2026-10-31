import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { createModels } from "@earendil-works/pi-ai"
import {
  Harness,
  createRegistry,
  defineDocFamily,
} from "@earendil-works/pi-durable"
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory"
import { expect, expectTypeOf, it } from "@effect/vitest"
import { Cause, Clock, Context, Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { it as test, vi } from "vitest"

import { delegationsRequest } from "../src/delegation/adapters/http"
import { delegationNative } from "../src/delegation/adapters/interop"
import { piDelegationLedger } from "../src/delegation/adapters/pi"
import { DelegationFailure, type Control } from "../src/delegation/contracts"
import {
  acceptControl,
  consumeRequest,
  projectGroup,
  type SavedGroup,
} from "../src/delegation/domain"
import { makeDelegations } from "../src/delegation/service"
import { resolveRoute } from "../src/inference/policy"

const authority = { current: () => true, cancelled: () => false }
const group = (): SavedGroup => ({
  id: 7,
  turnId: "turn",
  conversationId: 1,
  input: {
    objective: "Draft",
    tasks: [{ name: "Draft", task: "Keep private", tools: [] }],
  },
  route: resolveRoute("conversation"),
  memory: "Source",
  createdAt: 1000,
  deadline: 601000,
  revision: 0,
  closed: false,
  children: [
    {
      id: 1,
      name: "Draft",
      task: "Keep private",
      tools: [],
      requests: 0,
      stopped: false,
    },
  ],
  controls: [],
})
const seed = (ledger: ReturnType<typeof piDelegationLedger>, value = group()) =>
  ledger.atomic((tx) =>
    Effect.gen(function* () {
      ;(yield* tx.group(value.id)).value = value
      ;(yield* tx.catalog()).ids.push(value.id)
    })
  )
const fixture = <T, TError, TRequirements>(
  work: (
    h: Harness,
    ledger: ReturnType<typeof piDelegationLedger>
  ) => Effect.Effect<T, TError, TRequirements>
) =>
  Effect.acquireUseRelease(
    Effect.promise(() =>
      Harness.open(
        new MemoryStorage(),
        { models: createModels(), registry: createRegistry() },
        BACKGROUND_CONTEXT
      )
    ),
    (h) =>
      work(
        h,
        piDelegationLedger(
          async () => h,
          () => ({ name: "reader" }),
          () => []
        )
      ),
    (h) => Effect.promise(() => h.close(BACKGROUND_CONTEXT))
  )
const die = <T, TError>(exit: Exit.Exit<T, TError>, defect: unknown) =>
  Exit.isFailure(exit) &&
  exit.cause.reasons.some(
    (reason) => reason._tag === "Die" && reason.defect === defect
  )

it.effect(
  "the real Pi commit preserves caller Context and invocation Clock",
  () =>
    fixture((_h, ledger) => {
      class Caller extends Context.Service<Caller, { marker: string }>()(
        "DelegationCaller"
      ) {}
      const change = ledger.atomic((tx) =>
        Effect.gen(function* () {
          const caller = yield* Caller
          const now = yield* Clock.currentTimeMillis
          ;(yield* tx.group(7)).value = {
            ...group(),
            memory: caller.marker,
            createdAt: now,
          }
          return caller.marker
        })
      )
      expectTypeOf(change).toEqualTypeOf<
        Effect.Effect<string, DelegationFailure, Caller>
      >()
      return Effect.gen(function* () {
        yield* TestClock.setTime(123_000)
        expect(
          yield* change.pipe(
            Effect.provideService(Caller, { marker: "invocation" })
          )
        ).toBe("invocation")
        expect(yield* ledger.group(7)).toMatchObject({
          memory: "invocation",
          createdAt: 123_000,
        })
      })
    })
)

it.effect(
  "a typed decision failure rolls document and catalog writes back without becoming unavailable",
  () =>
    fixture((_h, ledger) =>
      Effect.gen(function* () {
        const refused = new DelegationFailure({
          code: "conflict",
          message: "Keep the first operation",
        })
        const exit = yield* ledger
          .atomic((tx) =>
            Effect.gen(function* () {
              ;(yield* tx.group(7)).value = group()
              ;(yield* tx.catalog()).ids.push(7)
              return yield* refused
            })
          )
          .pipe(Effect.exit)
        expect(
          Exit.isFailure(exit) &&
            exit.cause.reasons.some(
              (reason) => reason._tag === "Fail" && reason.error === refused
            )
        ).toBe(true)
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(false)
        expect(yield* ledger.catalog()).toEqual([])
        expect(yield* ledger.group(7).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { code: "not_found" },
        })
      })
    )
)

it.effect(
  "callback defects remain defects and abort the same native transaction",
  () =>
    fixture((_h, ledger) =>
      Effect.gen(function* () {
        const defect = new Error("Private invariant")
        const exit = yield* ledger
          .atomic((tx) =>
            Effect.gen(function* () {
              ;(yield* tx.group(7)).value = group()
              return yield* Effect.die(defect)
            })
          )
          .pipe(Effect.exit)
        expect(die(exit, defect)).toBe(true)
        expect(yield* ledger.group(7).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { code: "not_found" },
        })
      })
    )
)

it.effect(
  "a native document view refuses identity-changing writes before publication",
  () =>
    fixture((_h, ledger) =>
      Effect.gen(function* () {
        const exit = yield* ledger
          .atomic((tx) =>
            Effect.gen(function* () {
              ;(yield* tx.group(7)).value = { ...group(), id: 8 }
            })
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
        expect(yield* ledger.group(7).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { code: "not_found" },
        })
      })
    )
)

it.effect(
  "a matching task ID and brief cannot replay a group owned by a different parent turn",
  () =>
    fixture((_h, ledger) =>
      Effect.gen(function* () {
        yield* seed(ledger)
        const app = makeDelegations(
          {
            ...ledger,
            atomic: (body) =>
              ledger.atomic((tx) =>
                body({
                  ...tx,
                  owner: () =>
                    Effect.succeed({
                      conversationId: 1,
                      abortRequested: false,
                    }),
                })
              ),
          },
          authority
        )
        const result = yield* app
          .run(group().input, {
            turnId: "another-turn",
            conversationId: 1,
            taskId: 7,
            route: group().route,
            memory: "Other source",
          })
          .pipe(Effect.result)
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { code: "conflict" },
        })
        expect((yield* ledger.group(7)).turnId).toBe("turn")
        expect(yield* ledger.catalog()).toEqual([7])
      })
    )
)

test("interruption joins delayed callback cleanup and restores a late defect before rollback completes", async () => {
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((done) => {
      enter = done
    }),
    held = new Promise<void>((done) => {
      release = done
    })
  const defect = new Error("Late native callback cleanup")
  await Effect.runPromise(
    fixture((_h, ledger) =>
      Effect.promise(async () => {
        const fiber = Effect.runFork(
          ledger.atomic((tx) =>
            Effect.gen(function* () {
              ;(yield* tx.group(7)).value = group()
              enter()
              return yield* Effect.never
            }).pipe(
              Effect.ensuring(
                Effect.promise(() => held).pipe(
                  Effect.andThen(Effect.die(defect))
                )
              )
            )
          )
        )
        let joined = false
        try {
          await entered
          const stop = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
            joined = true
          })
          await Promise.resolve()
          expect(joined).toBe(false)
          release()
          await stop
          const exit = await Effect.runPromise(Fiber.await(fiber))
          expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(
            true
          )
          expect(die(exit, defect)).toBe(true)
          expect(await Effect.runPromise(ledger.catalog())).toEqual([])
          expect(
            await Effect.runPromise(ledger.group(7).pipe(Effect.result))
          ).toMatchObject({ _tag: "Failure", failure: { code: "not_found" } })
        } finally {
          release()
          await Effect.runPromise(Fiber.interrupt(fiber))
        }
      })
    )
  )
})

it.effect(
  "control publication is durable, replayable after authority ends, and conflicts on changed payload",
  () =>
    fixture((h, ledger) =>
      Effect.gen(function* () {
        const conversation = yield* Effect.promise(() =>
          h.root(BACKGROUND_CONTEXT)
        )
        const saved = {
          ...group(),
          children: [{ ...group().children[0]!, id: Number(conversation.id) }],
        }
        yield* seed(ledger, saved)
        let current = true
        const app = makeDelegations(ledger, {
          current: () => current,
          cancelled: () => false,
        })
        const input: Control = {
          groupId: 7,
          childId: Number(conversation.id),
          operationId: crypto.randomUUID(),
          action: { type: "stop" },
        }
        expect(yield* app.control(input)).toEqual({ accepted: true })
        expect(yield* ledger.operation(input.operationId)).toMatchObject({
          applied: true,
        })
        current = false
        expect(yield* app.control(input)).toEqual({ accepted: false })
        expect(
          yield* app
            .control({ ...input, action: { type: "steer", text: "Changed" } })
            .pipe(Effect.result)
        ).toMatchObject({ _tag: "Failure", failure: { code: "conflict" } })
        expect((yield* ledger.group(7)).controls).toEqual([input])
      })
    )
)

it.effect(
  "corrupt saved group codecs and document identities fail as defects",
  () =>
    fixture((h, ledger) =>
      Effect.gen(function* () {
        const Groups = defineDocFamily({
          checkpointWhen: () => false,
          kind: "delegation.group",
          scope: "session",
          family: true,
          version: 1,
          initial: (_: null) => ({ value: "" }),
        })
        for (const value of [
          '{"id":7}',
          JSON.stringify({ ...group(), id: 8 }),
        ]) {
          yield* Effect.promise(() =>
            h.commit(async (tx) => {
              ;(await tx.doc(Groups, "7", null)).value = value
            }, BACKGROUND_CONTEXT)
          )
          const exit = yield* makeDelegations(ledger, authority)
            .read(7)
            .pipe(Effect.exit)
          expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
          expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
        }
      })
    )
)

test("request and control decisions preserve the committed input and enforce exact budgets and stop fences", () => {
  let saved = group()
  for (let i = 0; i < 12; i++) saved = consumeRequest(saved, 1, 2000, authority)
  expect(saved.children[0]?.requests).toBe(12)
  expect(group().children[0]?.requests).toBe(0)
  expect(() => consumeRequest(saved, 1, 2000, authority)).toThrow(
    "execution limit"
  )
  expect(() => consumeRequest(group(), 1, group().deadline, authority)).toThrow(
    "execution limit"
  )
  expect(() =>
    consumeRequest(group(), 1, 2000, { ...authority, current: () => false })
  ).toThrow("parent request has ended")
  const input: Control = {
    groupId: 7,
    childId: 1,
    operationId: crypto.randomUUID(),
    action: { type: "steer", text: "Metric units" },
  }
  const stopped = acceptControl(
    group(),
    { ...input, action: { type: "stop" } },
    2000,
    authority
  )
  expect(() => acceptControl(stopped, input, 2000, authority)).toThrow(
    "child has stopped"
  )
  let steered = group()
  for (let i = 0; i < 8; i++)
    steered = acceptControl(
      steered,
      { ...input, operationId: crypto.randomUUID() },
      2000,
      authority
    )
  expect(() => acceptControl(steered, input, 2000, authority)).toThrow(
    "steering limit"
  )
})

test("projection keeps unknown usage and cancelled work distinct without leaking stopped storage fields", () => {
  const saved = group()
  const facts = [
    { inputs: [undefined], answer: "", inputTokens: null, outputTokens: null },
  ]
  expect(projectGroup(saved, facts, false, 2000).children[0]).toMatchObject({
    status: "queued",
    inputTokens: null,
  })
  expect(projectGroup(saved, facts, true, 2000)).toMatchObject({
    status: "cancelled",
    children: [{ status: "cancelled" }],
  })
  const projected = projectGroup(
    saved,
    [
      {
        ...facts[0]!,
        inputs: [{ status: "done" }],
        answer: "x".repeat(14000),
        inputTokens: 0,
        outputTokens: 0,
      },
    ],
    false,
    2000
  )
  expect(projected.children[0]).toMatchObject({
    status: "completed",
    inputTokens: 0,
  })
  expect(projected.children[0]).not.toHaveProperty("stopped")
  expect(projected.children[0]?.answer).toContain("Shortened")
})

test("native operations join late settlement after cancellation", async () => {
  let release!: () => void, observed!: () => void
  const held = new Promise<void>((done) => {
      release = done
    }),
    entered = new Promise<void>((done) => {
      observed = done
    })
  let signal: AbortSignal | undefined,
    joined = false
  const fiber = Effect.runFork(
    delegationNative(async (context) => {
      signal = context.abortSignal
      observed()
      await held
      return 1
    })
  )
  try {
    await entered
    const stop = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
      joined = true
    })
    await vi.waitFor(() => expect(signal?.aborted).toBe(true))
    expect(joined).toBe(false)
    release()
    await stop
  } finally {
    release()
    await Effect.runPromise(Fiber.interrupt(fiber))
  }
})

test("HTTP input is bounded before control dispatch and reader cleanup is joined", async () => {
  let release!: () => void,
    cleaning = false,
    settled = false
  const held = new Promise<void>((done) => {
      release = done
    }),
    control = vi.fn(() => Effect.succeed({ accepted: true }))
  const service = {
    list: () => Effect.succeed([]),
    read: () =>
      Effect.fail(
        new DelegationFailure({ code: "not_found", message: "Missing" })
      ),
    control,
    transcript: () => Effect.succeed({ entries: [], cursor: null }),
  }
  const requestOptions: RequestInit & { duplex: "half" } = {
    method: "POST",
    body: new ReadableStream<Uint8Array>({
      start(target) {
        target.enqueue(new Uint8Array(40001))
      },
      async cancel() {
        cleaning = true
        await held
      },
    }),
    duplex: "half",
  }
  const request = new Request(
    "https://local/delegations/control",
    requestOptions
  )
  const response = Effect.runPromise(
    delegationsRequest(service, request, "delegations/control")
  ).then((value) => {
    settled = true
    return value
  })
  try {
    await vi.waitFor(() => expect(cleaning).toBe(true))
    expect(settled).toBe(false)
    release()
    expect((await response).status).toBe(400)
    expect(control).not.toHaveBeenCalled()
  } finally {
    release()
    await response
  }
})

test("HTTP preserves a defect even when its payload has the handled domain error tag", async () => {
  const defect = new DelegationFailure({
    code: "unavailable",
    message: "Invariant failed",
  })
  const service = {
    list: () => Effect.die(defect),
    read: () => Effect.die(defect),
    control: () => Effect.die(defect),
    transcript: () => Effect.die(defect),
  }
  const exit = await Effect.runPromiseExit(
    delegationsRequest(
      service,
      new Request("https://local/delegations"),
      "delegations"
    )
  )
  expect(die(exit, defect)).toBe(true)
})
