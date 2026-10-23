import { Cause, Effect, Exit } from "effect"
import { expect, it } from "vitest"

import { backgroundNative } from "../src/delegation/adapters/interop"
import type { BackgroundNativeCommand } from "../src/delegation/background-task-dispatch.machine"
import { makeBackgroundTaskOwner } from "../src/delegation/background-task-owner"
import type { DelegationFailure } from "../src/delegation/contracts"

const barrier = () => {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

it.each([false, true])(
  "joins interrupted native settlement and retains late defects with record failure=%s",
  async (recordFails) => {
    const owner = makeBackgroundTaskOwner()
    const entered = barrier()
    const interrupted = barrier()
    const recording = barrier()
    const finishRecording = barrier()
    const caller = new AbortController()
    const defect = new Error(
      "Native submission failed after caller interruption"
    )
    const recordDefect = new Error("Uncertain submission could not be recorded")
    const command: BackgroundNativeCommand = {
      kind: "submit",
      child: 1,
      request: "background-initial:1",
      claim: 1,
      text: "draft",
      steer: false,
    }
    const trace: string[] = []
    const records: {
      command: BackgroundNativeCommand
      result: Exit.Exit<void, DelegationFailure>
      available: boolean
    }[] = []
    let rejectNative!: (cause: Cause.Cause<never>) => void
    let settled: Exit.Exit<void, DelegationFailure> | undefined
    const running = Effect.runPromiseExit(
      owner.run({
        claim: Effect.succeed(command),
        dispatch: () =>
          backgroundNative(
            (signal) =>
              new Promise<void>((_resolve, reject) => {
                rejectNative = reject
                signal.addEventListener(
                  "abort",
                  () => {
                    trace.push("native-interrupted")
                    interrupted.release()
                  },
                  { once: true }
                )
                trace.push("native-entered")
                entered.release()
              })
          ),
        record: (claimed, result) =>
          Effect.gen(function* () {
            records.push({
              command: claimed,
              result,
              available: yield* owner.available,
            })
            trace.push("record-entered")
            recording.release()
            yield* Effect.promise(() => finishRecording.promise)
            trace.push("record-settled")
            if (recordFails) return yield* Effect.die(recordDefect)
          }),
      }),
      { signal: caller.signal }
    ).then((exit) => {
      settled = exit
      trace.push("caller-settled")
      return exit
    })
    try {
      await entered.promise
      expect(await Effect.runPromise(owner.available)).toBe(false)
      caller.abort()
      await interrupted.promise
      expect(settled).toBeUndefined()
      expect(records).toEqual([])
      expect(await Effect.runPromise(owner.available)).toBe(false)

      trace.push("native-rejected")
      rejectNative(Cause.die(defect))
      await recording.promise
      expect(records).toHaveLength(1)
      expect(records[0]!.command).toEqual(command)
      expect(records[0]!.available).toBe(false)
      const recorded = records[0]!.result
      expect(Exit.isFailure(recorded)).toBe(true)
      if (Exit.isSuccess(recorded))
        throw new Error("Expected uncertain settlement")
      expect(Cause.hasInterrupts(recorded.cause)).toBe(true)
      expect(
        recorded.cause.reasons.some(
          (reason) => reason._tag === "Die" && reason.defect === defect
        )
      ).toBe(true)
      expect(settled).toBeUndefined()
      expect(await Effect.runPromise(owner.available)).toBe(false)

      finishRecording.release()
      const exit = await running
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) throw new Error("Expected interrupted owner")
      expect(Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(
        exit.cause.reasons.some(
          (reason) => reason._tag === "Die" && reason.defect === defect
        )
      ).toBe(true)
      expect(
        exit.cause.reasons.some(
          (reason) => reason._tag === "Die" && reason.defect === recordDefect
        )
      ).toBe(recordFails)
      expect(await Effect.runPromise(owner.available)).toBe(true)
      expect(trace).toEqual([
        "native-entered",
        "native-interrupted",
        "native-rejected",
        "record-entered",
        "record-settled",
        "caller-settled",
      ])
    } finally {
      caller.abort()
      rejectNative?.(Cause.die(defect))
      finishRecording.release()
      await running
    }
  }
)
