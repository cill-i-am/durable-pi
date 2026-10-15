import { Cause, Effect, Exit, Schema } from "effect"
import { expect, it } from "vitest"
import { nativeBytes } from "../src/shared/stream"
import { piSummaryCompletion } from "../src/memory/adapters/pi"
import { MemoryStorageError } from "../src/memory/domain"

class ReadFailed extends Schema.TaggedError<ReadFailed>()("ReadFailed", {}) {}
for (const mode of ["defect", "interruption", "compound"]) {
  it(`native byte reads retain a local ${mode} Cause`, async () => {
    const defect = new Error("private stream read defect")
    const cause =
      mode === "defect"
        ? Cause.die(defect)
        : mode === "interruption"
          ? Cause.interrupt()
          : Cause.fromReasons([
              Cause.makeFailReason(new ReadFailed()),
              Cause.makeDieReason(defect),
              Cause.makeInterruptReason(),
            ])
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => controller.error(cause),
    })
    const exit = await Effect.runPromiseExit(
      nativeBytes(
        body,
        8,
        () => new ReadFailed(),
        () => new ReadFailed()
      )
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(exit.cause.reasons.map((reason) => reason._tag)).toEqual(
        cause.reasons.map((reason) => reason._tag)
      )
      if (mode !== "interruption")
        expect(exit.cause.reasons).toContainEqual(
          expect.objectContaining({ _tag: "Die", defect })
        )
    }
    expect(body.locked).toBe(false)
  })
}
it("native byte-limit cleanup retains a separate compound cancellation Cause", async () => {
  const defect = new Error("private stream cancel defect")
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => controller.enqueue(new Uint8Array(2)),
    cancel: () =>
      Promise.reject(
        Cause.fromReasons([
          Cause.makeFailReason(new ReadFailed()),
          Cause.makeDieReason(defect),
        ])
      ),
  })
  const exit = await Effect.runPromiseExit(
    nativeBytes(
      body,
      1,
      () => new ReadFailed(),
      () => new ReadFailed()
    )
  )
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit))
    expect(exit.cause.reasons).toContainEqual(
      expect.objectContaining({ _tag: "Die", defect })
    )
  expect(body.locked).toBe(false)
})
it("a Cause-wrapped summary storage failure keeps its original operation", async () => {
  const failure = new MemoryStorageError({ operation: "resolve summary route" })
  const provider = piSummaryCompletion(() =>
    Promise.reject(Cause.fail(failure))
  )
  const exit = await Effect.runPromiseExit(
    provider.complete([], { start: 0, count: 1, source: "source", context: "" })
  )
  expect(Exit.isFailure(exit) && exit.cause.reasons).toMatchObject([
    {
      _tag: "Fail",
      error: { _tag: "MemoryStorageError", operation: failure.operation },
    },
  ])
})
