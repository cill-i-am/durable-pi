import { createEffectActor, waitFor } from "@xstate/effect"
import { Effect, Exit } from "effect"

import { observeCleanup } from "../shared/effect"
import { nativeOperation } from "../shared/interop"
import {
  advanceTerminalHost,
  initialTerminalHost,
  terminalHostWorkMachine,
} from "./host.machine"
import {
  advanceNativeHostImport,
  initialNativeHostImport,
  nativeHostImportMachine,
  type NativeImportIdentity,
} from "./native-host.machine"

export class NativeTerminalHost<E, Result> {
  private videoState = initialTerminalHost()
  private importState = initialNativeHostImport()
  private readonly videos = new Map<string, Promise<Response>>()
  private readonly imports = new Map<string, Promise<Result>>()
  constructor(
    private readonly work: {
      runExit: <T>(
        work: Effect.Effect<T, E>,
        options?: { signal?: AbortSignal }
      ) => Promise<Exit.Exit<T, E>>
      writable: () => boolean
      receipt: () => NativeImportIdentity | undefined
      import: (receipt: NativeImportIdentity) => Promise<Result>
    }
  ) {}
  private native<T>(start: () => Promise<T>) {
    return nativeOperation(start, (cause, channel) => {
      if (channel === "failure") return cause as E
      throw cause
    })
  }
  private async run<T>(work: Effect.Effect<T, E>, signal?: AbortSignal) {
    // Native joins need every failure reason, including late cleanup after
    // interruption. The runtime returns Exit without squashing its Cause.
    const exit = await this.work.runExit(work, { signal })
    if (Exit.isFailure(exit)) throw exit.cause
    return exit.value
  }

  video(work: Effect.Effect<Response, E>, signal: AbortSignal) {
    const token = crypto.randomUUID()
    this.videoState = advanceTerminalHost(this.videoState, {
      type: "VIDEO",
      token,
      allowed: this.importState.matches("idle") && this.work.writable(),
    })
    if (this.videoState.context.video !== token)
      return Promise.resolve(new Response("Busy", { status: 503 }))
    const pending = Promise.resolve()
      .then(() =>
        this.run(
          observeCleanup(work, (observed) =>
            Effect.gen(function* () {
              const actor = yield* createEffectActor(
                terminalHostWorkMachine(observed)
              )
              const done = yield* waitFor(
                actor,
                (state) => state.status === "done"
              ).pipe(Effect.orDie)
              return yield* done.output!
            }).pipe(Effect.scoped)
          ),
          signal
        )
      )
      .finally(() => {
        this.videoState = advanceTerminalHost(this.videoState, {
          type: "VIDEO_JOINED",
          token,
        })
        this.videos.delete(token)
      })
    this.videos.set(token, pending)
    return pending
  }
  import(receipt: NativeImportIdentity): Promise<Result> {
    // Copy before dispatch or any await: callers may reuse/mutate their input.
    const immutable = Object.freeze({
      owner: receipt.owner,
      name: receipt.name,
      key: receipt.key,
      sha256: receipt.sha256,
      size: receipt.size,
    })
    const token = crypto.randomUUID()
    this.importState = advanceNativeHostImport(this.importState, {
      type: "IMPORT",
      token,
      receipt: immutable,
      persisted: this.work.receipt() ?? null,
    })
    if (this.importState.context.accepted !== token)
      return Promise.reject(new Error("Conflicting terminal migration"))
    const admitted = this.importState.context.token!
    if (admitted !== token) return this.imports.get(admitted)!
    const videoToken = this.videoState.context.video
    const video = videoToken ? this.videos.get(videoToken) : undefined
    const joining = video
      ? this.native(() => video).pipe(Effect.asVoid)
      : Effect.void
    const importing = this.native(() => this.work.import(immutable))
    const pending = Promise.resolve()
      .then(() =>
        this.run(
          observeCleanup(joining, (joinVideo) =>
            observeCleanup(importing, (importWork) =>
              Effect.gen(function* () {
                const actor = yield* createEffectActor(
                  nativeHostImportMachine({ joinVideo, import: importWork })
                )
                const done = yield* waitFor(
                  actor,
                  (state) => state.status === "done"
                ).pipe(Effect.orDie)
                return yield* done.output!
              }).pipe(Effect.scoped)
            )
          )
        )
      )
      .finally(() => {
        this.importState = advanceNativeHostImport(this.importState, {
          type: "JOINED",
          token,
        })
        this.imports.delete(token)
      })
    this.imports.set(token, pending)
    return pending
  }
}
