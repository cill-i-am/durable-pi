import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { createModels } from "@earendil-works/pi-ai"
import { Harness, createRegistry } from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import { Cause, Effect, Exit, Schema } from "effect"
import { afterEach, expect, it } from "vitest"

import { piDelegationLedger } from "../src/delegation/adapters/pi"
import { piObjectLedger } from "../src/objects/adapters/pi"
import { piPlanLedger } from "../src/planning/adapters/pi"

class Refused extends Schema.TaggedError<Refused>()("CallbackRefused", {}) {}
const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

const cases: readonly {
  name: string
  open: (harness: Harness) => {
    fail: (error: Refused) => Effect.Effect<unknown, unknown>
    read: () => Effect.Effect<unknown, unknown>
    empty: unknown
  }
}[] = [
  {
    name: "Objects",
    open: (harness) => {
      const ledger = piObjectLedger(async () => harness)
      return {
        fail: (error) =>
          ledger.atomic((tx) =>
            tx.catalog().pipe(
              Effect.tap((catalog) =>
                Effect.sync(() => {
                  catalog.sequence = 9
                })
              ),
              Effect.andThen(Effect.fail(error))
            )
          ),
        read: () =>
          ledger.atomic((tx) =>
            tx.catalog().pipe(Effect.map((catalog) => catalog.sequence))
          ),
        empty: 0,
      }
    },
  },
  {
    name: "Planning",
    open: (harness) => {
      const ledger = piPlanLedger(
        async () => harness,
        () => (ref) =>
          Effect.succeed({ ...ref, state: "valid", detail: "Saved source" })
      )
      return {
        fail: (error) =>
          ledger.atomic((tx) =>
            tx.catalog().pipe(
              Effect.tap((catalog) =>
                Effect.sync(() => {
                  catalog.ids.push(crypto.randomUUID())
                })
              ),
              Effect.andThen(Effect.fail(error))
            )
          ),
        read: ledger.catalog,
        empty: [],
      }
    },
  },
  {
    name: "Delegation",
    open: (harness) => {
      const ledger = piDelegationLedger(
        async () => harness,
        () => ({ name: "reader" }),
        () => []
      )
      return {
        fail: (error) =>
          ledger.atomic((tx) =>
            tx.catalog().pipe(
              Effect.tap((catalog) =>
                Effect.sync(() => {
                  catalog.ids.push(7)
                })
              ),
              Effect.andThen(Effect.fail(error))
            )
          ),
        read: ledger.catalog,
        empty: [],
      }
    },
  },
]

async function fixture(spec: (typeof cases)[number]) {
  const directory = await mkdtemp(join(tmpdir(), "pi-commit-failure-"))
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(directory, "pi.sqlite")),
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT
  )
  const commit = harness.commit.bind(harness)
  closers.push(async () => {
    harness.commit = commit
    await harness.close(BACKGROUND_CONTEXT)
    await rm(directory, { recursive: true, force: true })
  })
  return { harness, commit, ...spec.open(harness) }
}

for (const spec of cases) {
  it.each(["raw", "compound"])(
    `${spec.name} retains a separate native %s settlement failure after callback rollback`,
    async (mode) => {
      const f = await fixture(spec)
      const rejected = new Refused()
      const defect = new Error("private native settlement failure")
      f.harness.commit = async (change, context) => {
        try {
          return await f.commit(change, context)
        } catch {
          throw mode === "raw"
            ? defect
            : Cause.fromReasons([
                Cause.makeDieReason(defect),
                Cause.makeInterruptReason(),
              ])
        }
      }
      const exit = await Effect.runPromiseExit(f.fail(rejected))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons).toContainEqual(
          expect.objectContaining({ _tag: "Fail", error: rejected })
        )
        expect(exit.cause.reasons).toContainEqual(
          expect.objectContaining({ _tag: "Die", defect })
        )
        if (mode === "compound")
          expect(Cause.hasInterrupts(exit.cause)).toBe(true)
      }
      f.harness.commit = f.commit
      expect(await Effect.runPromise(f.read())).toEqual(f.empty)
    }
  )

  it(`${spec.name} joins and retains a separate late settlement defect after interruption`, async () => {
    const f = await fixture(spec)
    let entered!: () => void, release!: () => void
    const admitted = new Promise<void>((resolve) => {
      entered = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const defect = new Error("private late settlement failure")
    f.harness.commit = async (change, context) => {
      try {
        return await f.commit(change, context)
      } catch {
        entered()
        await held
        throw Cause.die(defect)
      }
    }
    const controller = new AbortController()
    let settled = false
    const result = Effect.runPromiseExit(f.fail(new Refused()), {
      signal: controller.signal,
    }).then((exit) => {
      settled = true
      return exit
    })
    await admitted
    controller.abort()
    await Promise.resolve()
    expect(settled).toBe(false)
    release()
    const exit = await result
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(exit.cause.reasons).toContainEqual(
        expect.objectContaining({ _tag: "Die", defect })
      )
    }
    f.harness.commit = f.commit
    expect(await Effect.runPromise(f.read())).toEqual(f.empty)
  })
}
