import { sqliteFailure } from "./sqlite-fault"
import { expect, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit } from "effect"
import { TestClock } from "effect/testing"
import { database } from "./database"
import { ExecutionStore } from "../src/execution/adapters/sqlite"
import { makeExecutions } from "../src/execution/service"
import { admitExecution } from "../src/execution/domain"
import { ExecutorUnavailable } from "../src/execution/executor"

const input = { id: "clock-run", code: "return 3", data: "null" }
const output = { result: "3", logs: "", error: null }

it.effect(
  "execution uses invocation Clock for admission and completion, retaining original replay timestamps",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        const ledger = new ExecutionStore(database())
        const execution = yield* makeExecutions(
          ledger,
          { run: () => Deferred.await(gate).pipe(Effect.as(output)) },
          () => Effect.sync(() => true)
        )
        yield* TestClock.setTime(20_000)
        const task = yield* execution.start(input)
        expect(task.run.createdAt).toBe(20_000)
        yield* TestClock.setTime(30_000)
        yield* Deferred.succeed(gate, undefined)
        const completed = yield* task.completion
        expect(completed.finishedAt).toBe(30_000)
        yield* TestClock.setTime(40_000)
        expect((yield* execution.start(input)).run).toEqual(completed)
      })
    )
)

it.effect(
  "replay precedes archive/capacity checks, while capacity and exact input identity remain enforced",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const ledger = new ExecutionStore(database())
        const admitted = yield* Effect.fromResult(
          admitExecution(
            input,
            undefined,
            { total: 0, running: 0 },
            true,
            false,
            100
          )
        )
        yield* ledger.atomic(() =>
          Effect.gen(function* () {
            for (let n = 0; n < 500; n++)
              yield* ledger.put({
                ...admitted.run,
                id: n === 0 ? input.id : `run-${n}`,
                status: "interrupted",
                finishedAt: 200,
              })
          })
        )
        let writable = false
        const invoke = () => Effect.die("replayed code must not execute")
        const execution = yield* makeExecutions(ledger, { run: invoke }, () =>
          Effect.sync(() => writable)
        )
        expect((yield* execution.run(input)).status).toBe("interrupted")
        expect(
          yield* execution.start({ ...input, data: "3" }).pipe(Effect.result)
        ).toMatchObject({
          _tag: "Failure",
          failure: { message: expect.stringContaining("different code") },
        })
        writable = true
        expect(
          yield* execution.start({ ...input, id: "new" }).pipe(Effect.result)
        ).toMatchObject({
          _tag: "Failure",
          failure: { message: expect.stringContaining("500-run") },
        })
        expect(Effect.runSync(ledger.counts())).toEqual({
          total: 500,
          running: 0,
        })
      })
    )
)

it.effect(
  "a native commit failure rolls admission back and dispatches no code",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const db = database()
        let failCommit = false,
          calls = 0
        const ledger = new ExecutionStore({
          ...db,
          transaction: (body) =>
            db.transaction(() =>
              body().pipe(
                Effect.flatMap((value) =>
                  failCommit
                    ? Effect.fail(sqliteFailure("native commit failed"))
                    : Effect.succeed(value)
                )
              )
            ),
        })
        const execution = yield* makeExecutions(
          ledger,
          {
            run: () =>
              Effect.sync(() => {
                calls++
                return output
              }),
          },
          () => Effect.sync(() => true)
        )
        failCommit = true
        expect(yield* execution.start(input).pipe(Effect.result)).toMatchObject(
          { _tag: "Failure", failure: { _tag: "ExecutionStorageError" } }
        )
        expect(Effect.runSync(ledger.get(input.id))).toBeUndefined()
        expect(calls).toBe(0)
        failCommit = false
        expect((yield* execution.run(input)).status).toBe("succeeded")
        expect(calls).toBe(1)
      })
    )
)

it.effect(
  "expected executor unavailability is a bounded saved failure without retry",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let calls = 0
        const execution = yield* makeExecutions(
          new ExecutionStore(database()),
          {
            run: () => {
              calls++
              return Effect.fail(new ExecutorUnavailable())
            },
          },
          () => Effect.sync(() => true)
        )
        const saved = yield* execution.run(input)
        expect(saved.status).toBe("failed")
        expect(saved.output).toMatchObject({
          result: "",
          logs: "",
          error: expect.stringContaining("Inspect the code"),
        })
        expect(yield* execution.run(input)).toEqual(saved)
        expect(calls).toBe(1)
      })
    )
)

it.effect(
  "cancel joins failed teardown and retains its defect instead of returning an ordinary stopped receipt",
  () =>
    Effect.gen(function* () {
      const defect = new Error("cancel teardown")
      const entered = yield* Deferred.make<void>()
      let ledger!: ExecutionStore
      const exit = yield* Effect.scoped(
        Effect.gen(function* () {
          ledger = new ExecutionStore(database())
          const execution = yield* makeExecutions(
            ledger,
            {
              run: () =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.ensuring(Effect.die(defect))
                ),
            },
            () => Effect.sync(() => true)
          )
          yield* execution.start(input)
          yield* Deferred.await(entered)
          const stopped = yield* execution.cancel(input.id).pipe(Effect.exit)
          expect(
            Exit.isFailure(stopped) &&
              stopped.cause.reasons.some(
                (reason) => reason._tag === "Die" && reason.defect === defect
              )
          ).toBe(true)
          expect(Effect.runSync(ledger.get(input.id))?.status).toBe("cancelled")
        })
      ).pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(Effect.runSync(ledger.get(input.id))?.output).toBeNull()
    })
)

it.effect("an admitted stop before dispatch does not invoke the executor", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let calls = 0
      const execution = yield* makeExecutions(
        new ExecutionStore(database()),
        {
          run: () =>
            Effect.sync(() => {
              calls++
              return output
            }),
        },
        () => Effect.sync(() => true)
      )
      const task = yield* execution.start(input)
      expect((yield* execution.cancel(input.id)).status).toBe("cancelled")
      expect((yield* task.completion).status).toBe("cancelled")
      expect(calls).toBe(0)
    })
  )
)

it.effect(
  "failed terminal commits preserve the uncertain intent and cannot redispatch code",
  () =>
    Effect.gen(function* () {
      const db = database()
      let failCommit = false,
        calls = 0
      const ledger = new ExecutionStore({
        ...db,
        transaction: (body) =>
          db.transaction(() =>
            body().pipe(
              Effect.flatMap((value) =>
                failCommit
                  ? Effect.fail(sqliteFailure("failed terminal commit"))
                  : Effect.succeed(value)
              )
            )
          ),
      })
      const exit = yield* Effect.scoped(
        Effect.gen(function* () {
          const execution = yield* makeExecutions(
            ledger,
            {
              run: () =>
                Effect.sync(() => {
                  calls++
                  failCommit = true
                  return output
                }),
            },
            () => Effect.sync(() => true)
          )
          const task = yield* execution.start(input)
          const failed = yield* task.completion.pipe(Effect.exit)
          expect(
            Exit.isFailure(failed) &&
              Cause.hasFails(failed.cause) &&
              !Cause.hasDies(failed.cause)
          ).toBe(true)
          expect(Effect.runSync(ledger.get(input.id))?.status).toBe("running")
          expect(
            yield* execution.start(input).pipe(Effect.result)
          ).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "ExecutionStorageError" },
          })
          expect(calls).toBe(1)
        })
      ).pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    })
)
