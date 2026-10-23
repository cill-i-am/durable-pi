import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type {
  GenerationHooks,
  HookApi,
  Storage,
} from "@earendil-works/pi-durable"
import { it } from "@effect/vitest"
import { Cause, Context, Deferred, Effect, Exit, Fiber } from "effect"
import { describe, expect, test } from "vitest"

import { runRecoveryHook } from "../src/conversations/adapters/pi-recovery"
import { RunRecoveryStore } from "../src/conversations/adapters/sqlite-recovery"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import {
  decodeRecoveryState,
  initialRecovery,
  type Observation,
} from "../src/conversations/recovery"
import {
  runRecoveryHookProgram,
  type RecoveryHookWork,
} from "../src/conversations/recovery-service"
import {
  advanceToolRecovery,
  observeRound,
  requireToolRecoveryDescriptors,
  type ToolRecoveryEvent,
} from "../src/conversations/tool-recovery.machine"
import { orDieAll } from "../src/shared/effect"
import { database } from "./database"

const call = (
  resultId: number,
  outcome: Observation["outcome"] = "failure"
): Observation => ({
  resultId,
  invocation: `task:${resultId}`,
  tool: "read",
  fingerprint: "same",
  outcome,
  receiptId: `receipt:${resultId}`,
})
const warning = () =>
  observeRound(initialRecovery("epoch"), "epoch", "epoch", [
    call(1),
    call(2),
    call(3),
  ])
const blocked = () =>
  observeRound(warning(), "epoch", "epoch", [call(4), call(5)])
function ledgerFixture() {
  const db = database()
  const turns = new ConversationStore(db, { model: "test", thinking: "off" })
  Effect.runSync(
    turns.admit(
      { operationId: "root", text: "Synthetic recovery" },
      undefined,
      [],
      undefined,
      { discoveryDeadline: Date.now() + 60000 }
    )
  )
  Effect.runSync(turns.submitted("root", "session"))
  return { db, store: new RunRecoveryStore(db) }
}
const restoredStates = [
  ["idle", initialRecovery("epoch")],
  ["recovering", warning()],
  [
    "recovered",
    observeRound(warning(), "epoch", "epoch", [call(4, "success")]),
  ],
  ["blocked repetition", blocked()],
  [
    "blocked denied",
    observeRound(initialRecovery("epoch"), "epoch", "epoch", [
      call(1, "denied"),
    ]),
  ],
  [
    "blocked uncertain",
    observeRound(initialRecovery("epoch"), "epoch", "epoch", [
      call(1, "uncertain"),
    ]),
  ],
] as const

describe("durable official tool recovery machine", () => {
  test.each(restoredStates)(
    "restores %s from existing version-1 JSON without executing work",
    (_name, saved) => {
      const f = ledgerFixture()
      const { workflowVersion: _version, ...legacy } = saved
      f.db.run(
        "UPDATE chat_turns SET recovery=? WHERE id='root'",
        JSON.stringify({ ...legacy, historicalMarker: "preserved" })
      )
      expect(Effect.runSync(f.store.get("root"))).toEqual({
        ...saved,
        historicalMarker: "preserved",
      })
      const next = Effect.runSync(
        f.store.observe("root", "session", "epoch", "epoch", [])
      )
      expect(next).toEqual({ ...saved, historicalMarker: "preserved" })
      expect(
        JSON.parse(
          f.db.all<{ recovery: string }>(
            "SELECT recovery FROM chat_turns WHERE id='root'"
          )[0]!.recovery
        )
      ).toEqual(next)
      expect(f.db.all("SELECT * FROM chat_recovery_history")).toEqual([])
    }
  )
  test("absorbing blocked replay preserves historical text and never adds history", () => {
    const f = ledgerFixture(),
      saved = blocked()
    saved.view!.detail = "Historical recovery instructions"
    f.db.run(
      "UPDATE chat_turns SET recovery=? WHERE id='root'",
      JSON.stringify(saved)
    )
    expect(
      Effect.runSync(
        f.store.observe("root", "session", "new steering", "new steering", [
          call(8, "success"),
        ])
      )
    ).toEqual(saved)
    expect(f.db.all("SELECT * FROM chat_recovery_history")).toEqual([])
  })
  test("rejects unknown versions and invalid domain projections without rewriting storage", () => {
    const f = ledgerFixture()
    for (const saved of [
      { ...warning(), version: 2 },
      { ...warning(), workflowVersion: 2 },
      { ...warning(), workflowVersion: undefined },
      {
        ...warning(),
        buckets: Array.from({ length: 33 }, (_, index) => ({
          fingerprint: String(index),
          count: 1,
        })),
      },
      { ...warning(), view: { ...warning().view, reason: "uncertain" } },
    ]) {
      if (
        Object.hasOwn(saved, "workflowVersion") &&
        saved.workflowVersion === undefined
      ) {
        expect(() => decodeRecoveryState(saved)).toThrow()
        continue
      }
      const raw = JSON.stringify(saved)
      f.db.run("UPDATE chat_turns SET recovery=? WHERE id='root'", raw)
      expect(() =>
        Effect.runSync(f.store.observe("root", "session", "epoch", "epoch", []))
      ).toThrow()
      expect(
        f.db.all<{ recovery: string }>(
          "SELECT recovery FROM chat_turns WHERE id='root'"
        )[0]!.recovery
      ).toBe(raw)
      expect(f.db.all("SELECT * FROM chat_recovery_history")).toEqual([])
    }
  })
  test("validates complete events, including blocked replays, and rejects every executable descriptor", () => {
    for (const saved of [initialRecovery("epoch"), blocked()]) {
      for (const event of [
        {
          type: "ROUND_OBSERVED",
          epoch: "epoch",
          requestEpoch: "epoch",
          observations: [{ ...call(8), resultId: -1 }],
        },
        {
          type: "ROUND_OBSERVED",
          epoch: "epoch",
          requestEpoch: "epoch",
          observations: [{ ...call(8), outcome: "unknown" }],
        },
        {
          type: "ROUND_OBSERVED",
          epoch: 123,
          requestEpoch: "epoch",
          observations: [],
        },
        { type: "UNKNOWN" },
      ])
        expect(() =>
          advanceToolRecovery(saved, event as ToolRecoveryEvent)
        ).toThrow()
    }
    for (const type of [
      "@xstate.execute",
      "@xstate.spawn",
      "@xstate.send",
      "@xstate.schedule",
      "@xstate.terminate",
      "@xstate.deadLetter",
      "custom.command",
    ])
      expect(() => requireToolRecoveryDescriptors([{ type }])).toThrow(
        "Unsupported tool recovery effect"
      )
  })
  test("malformed round rolls back state and history before admitting any result", () => {
    const f = ledgerFixture()
    Effect.runSync(
      f.store.observe("root", "session", "epoch", "epoch", [
        call(1),
        call(2),
        call(3),
      ])
    )
    const before = f.db.all("SELECT recovery FROM chat_turns"),
      history = f.db.all("SELECT * FROM chat_recovery_history")
    expect(() =>
      Effect.runSync(
        f.store.observe("root", "session", "epoch", "epoch", [
          call(4),
          { ...call(5), outcome: "unknown" } as unknown as Observation,
        ])
      )
    ).toThrow()
    expect(f.db.all("SELECT recovery FROM chat_turns")).toEqual(before)
    expect(f.db.all("SELECT * FROM chat_recovery_history")).toEqual(history)
  })
  test("uncertainty outranks denial irrespective of result order, while a repetition stop outranks earlier success", () => {
    for (const observations of [
      [call(4, "denied"), call(5, "uncertain")],
      [call(4, "uncertain"), call(5, "denied")],
    ])
      expect(
        observeRound(warning(), "new steering", "old epoch", observations).view
          ?.reason
      ).toBe("uncertain")
    expect(
      observeRound(warning(), "epoch", "epoch", [
        call(4, "success"),
        call(5),
        call(6),
      ]).view?.phase
    ).toBe("blocked")
  })
})

function hookFixture(kind: "before" | "after" = "after", state = warning()) {
  const calls: string[] = []
  const step = <A>(name: string, value: A) =>
    Effect.sync(() => {
      calls.push(name)
      return value
    })
  const work: RecoveryHookWork<string> = {
    kind,
    source: step("source", { turnId: "root", steeringKey: "steer" }),
    collect: () => step("collect", [call(4)]),
    hash: () => step("hash", "epoch"),
    remember: () => step("remember", undefined),
    recall: step("recall", "epoch"),
    read: () => step("read", warning()),
    commit: () => step("commit", state),
    publish: () => step("publish", undefined),
    stop: step("stop", undefined),
  }
  return { work, calls, step }
}

it.effect(
  "the scoped hook orders admission, publication and blocked native Stop",
  () =>
    Effect.gen(function* () {
      const after = hookFixture("after", blocked())
      const exit = yield* Effect.exit(runRecoveryHookProgram(after.work))
      expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true)
      expect(after.calls).toEqual([
        "source",
        "collect",
        "hash",
        "recall",
        "source",
        "read",
        "commit",
        "publish",
        "stop",
      ])
      const before = hookFixture("before")
      expect(yield* runRecoveryHookProgram(before.work)).toEqual(warning())
      expect(before.calls).toEqual([
        "source",
        "hash",
        "source",
        "remember",
        "source",
        "commit",
      ])
    })
)

for (const stage of [
  "source",
  "collect",
  "hash",
  "recall",
  "read",
  "commit",
  "publish",
  "stop",
] as const)
  it.effect(
    `preserves every Cause reason from hook ${stage} and does not advance afterward`,
    () =>
      Effect.gen(function* () {
        const f = hookFixture("after", blocked()),
          defect = new Error(`defect:${stage}`)
        const cause = Cause.fromReasons([
          Cause.makeFailReason(`failure:${stage}`).annotate(
            Context.makeUnsafe(new Map([["recovery-test", stage]]))
          ),
          Cause.makeDieReason(defect),
        ])
        const failed = Effect.failCause(cause)
        if (stage === "source" || stage === "recall" || stage === "stop")
          f.work[stage] = failed
        else f.work[stage] = () => failed
        const exit = yield* Effect.exit(runRecoveryHookProgram(f.work))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(exit.cause.reasons).toHaveLength(2)
          const failure = exit.cause.reasons.find(
            (reason) => reason._tag === "Fail"
          )
          expect(failure?.error).toBe(`failure:${stage}`)
          expect(failure?.annotations.get("recovery-test")).toBe(stage)
          expect(
            exit.cause.reasons.some(
              (reason) => reason._tag === "Die" && reason.defect === defect
            )
          ).toBe(true)
        }
        expect(f.calls).not.toContain(stage)
        if (stage !== "stop") expect(f.calls).not.toContain("stop")
      })
  )

it.effect(
  "interruption joins held hook cleanup and preserves failed teardown without publishing or stopping Pi",
  () =>
    Effect.gen(function* () {
      const f = hookFixture(),
        entered = yield* Deferred.make<void>(),
        cleaning = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>()
      const refused = Cause.makeFailReason("cleanup refused"),
        defect = new Error("cleanup defect")
      f.work.commit = () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Deferred.succeed(cleaning, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(
                orDieAll(
                  Effect.failCause(
                    Cause.fromReasons([refused, Cause.makeDieReason(defect)])
                  )
                )
              )
            )
          )
        )
      const pass = yield* runRecoveryHookProgram(f.work).pipe(
        Effect.exit,
        Effect.forkScoped
      )
      yield* Deferred.await(entered)
      const stopping = yield* Fiber.interrupt(pass).pipe(Effect.forkChild)
      yield* Deferred.await(cleaning)
      expect(stopping.pollUnsafe()).toBeUndefined()
      expect(f.calls).not.toContain("publish")
      expect(f.calls).not.toContain("stop")
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(stopping)
      const exit = pass.pollUnsafe()
      expect(
        exit && Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)
      ).toBe(true)
      if (exit && Exit.isFailure(exit)) {
        expect(
          exit.cause.reasons.some(
            (reason) => reason._tag === "Die" && reason.defect === defect
          )
        ).toBe(true)
        expect(
          exit.cause.reasons.some(
            (reason) =>
              reason._tag === "Die" &&
              Cause.isReason(reason.defect) &&
              Cause.isFailReason(reason.defect) &&
              reason.defect.error === refused.error
          )
        ).toBe(true)
      }
    }).pipe(Effect.scoped)
)

test("native hook refreshes the source callback at each check and retains the exact self-abort context", async () => {
  const f = ledgerFixture(),
    saved = blocked()
  f.db.run(
    "UPDATE chat_turns SET recovery=? WHERE id='root'",
    JSON.stringify(saved)
  )
  const memoContexts: unknown[] = [],
    stopped: unknown[] = []
  let checks = 0,
    switched = true
  const recovery = runRecoveryHook({
    storage: {} as Storage,
    store: f.store,
    access: {
      get: () => Effect.succeed(undefined),
      policies: () => Effect.succeed([]),
    },
    source: () =>
      Effect.succeed({
        turnId: "root",
        steeringKey: switched && ++checks > 1 ? "changed" : "epoch",
      }),
    stop: async (_api, context) => {
      stopped.push(context)
    },
  }).handlers as GenerationHooks
  const api = {
    conversationId: "session",
    memo: async (_key: string, _value: unknown, context: unknown) => {
      memoContexts.push(context)
    },
  } as unknown as HookApi
  await recovery.beforeRequest({ messages: [] }, api, BACKGROUND_CONTEXT)
  expect(checks).toBe(2)
  expect(memoContexts).toEqual([])
  expect(stopped).toEqual([])
  switched = false
  await expect(
    recovery.beforeRequest({ messages: [] }, api, BACKGROUND_CONTEXT)
  ).rejects.toBeDefined()
  expect(memoContexts).toEqual([BACKGROUND_CONTEXT])
  expect(stopped).toEqual([BACKGROUND_CONTEXT])
})

for (const stage of [
  "source",
  "collect",
  "hash",
  "remember",
  "recall",
  "read",
  "commit",
  "publish",
  "stop",
] as const)
  it.effect(
    `interrupted hook ${stage} joins its invocation and cannot progress`,
    () =>
      Effect.gen(function* () {
        const f = hookFixture(
          stage === "remember" ? "before" : "after",
          blocked()
        )
        const entered = yield* Deferred.make<void>(),
          cleaning = yield* Deferred.make<void>(),
          release = yield* Deferred.make<void>()
        const held = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Deferred.succeed(cleaning, undefined).pipe(
              Effect.andThen(Deferred.await(release))
            )
          )
        )
        if (stage === "source" || stage === "recall" || stage === "stop")
          f.work[stage] = held
        else f.work[stage] = () => held
        const pass = yield* runRecoveryHookProgram(f.work).pipe(
          Effect.forkScoped
        )
        yield* Deferred.await(entered)
        const before = [...f.calls]
        const closing = yield* Fiber.interrupt(pass).pipe(Effect.forkChild)
        yield* Deferred.await(cleaning)
        expect(closing.pollUnsafe()).toBeUndefined()
        expect(f.calls).toEqual(before)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(closing)
        expect(f.calls).toEqual(before)
      }).pipe(Effect.scoped)
  )

it.effect(
  "the final transaction source guard rejects authority revoked after the hook precheck",
  () =>
    Effect.gen(function* () {
      const f = ledgerFixture(),
        entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>(),
        h = hookFixture()
      let authorized = true
      h.work.source = Effect.sync(() =>
        authorized ? { turnId: "root", steeringKey: "epoch" } : undefined
      )
      h.work.collect = () => Effect.succeed([call(1), call(2), call(3)])
      h.work.read = () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(Effect.succeed(undefined))
        )
      h.work.commit = ({ epoch, requestEpoch, observations }) =>
        f.store
          .observe(
            "root",
            "session",
            epoch,
            requestEpoch,
            observations,
            undefined,
            () => Effect.sync(() => (authorized ? "epoch" : undefined))
          )
          .pipe(Effect.mapError(() => "storage failed"))
      const pass = yield* runRecoveryHookProgram(h.work).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      authorized = false
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(pass)).toBeUndefined()
      expect(yield* f.store.get("root")).toBeUndefined()
      expect(f.db.all("SELECT * FROM chat_recovery_history")).toEqual([])
      expect(h.calls).not.toContain("stop")
    }).pipe(Effect.scoped)
)
