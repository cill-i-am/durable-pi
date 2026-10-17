import { Cause, Effect } from "effect"

import { orDieAll } from "../../shared/effect"
import {
  nativeFailure,
  nativeOperation,
  releaseUnreadResponse,
} from "../../shared/interop"
import type { Checkpoint } from "../contracts"
import {
  TerminalRuntimeError,
  type TerminalRuntime,
  type CheckpointStorage,
  type InteractiveRuntime,
} from "../runtime"
import { fileDigest } from "./files"

export interface ForeignInteractiveRuntime {
  connect: (request: Request) => Promise<Response>
  close: () => Promise<void>
}

export interface ForeignTerminalRuntime {
  importFile?: (
    path: string,
    bytes: Uint8Array,
    signal: AbortSignal
  ) => Promise<void>
  exportFile?: (path: string, signal: AbortSignal) => Promise<Uint8Array>
  openInteractive?: (signal: AbortSignal) => Promise<ForeignInteractiveRuntime>
  restore: (
    bytes: Uint8Array | null,
    signal: AbortSignal,
    unrestricted?: boolean
  ) => Promise<void>
  execute: (
    command: string,
    output: (text: string) => void,
    signal: AbortSignal
  ) => Promise<number>
  snapshot: (signal: AbortSignal) => Promise<Uint8Array>
  close: () => Promise<void>
}
export interface ForeignCheckpointStorage {
  read: (checkpoint: Checkpoint) => Promise<Uint8Array>
  write: (bytes: Uint8Array) => Promise<Checkpoint>
}

function foreignOperations() {
  const pending = new Set<Promise<unknown>>()
  const late: Cause.Cause<TerminalRuntimeError>[] = []
  const call = <T>(
    operation: string,
    body: (signal: AbortSignal) => Promise<T>
  ) =>
    Effect.callback<T, TerminalRuntimeError>((resume, signal) => {
      let interrupted = false
      let task: Promise<T>
      try {
        task = body(signal)
      } catch (cause) {
        resume(Effect.die(cause))
        return
      }
      pending.add(task)
      task.then(
        (value) => {
          pending.delete(task)
          resume(Effect.succeed(value))
        },
        (cause) => {
          pending.delete(task)
          const failed = nativeFailure(
            cause,
            (error) => new TerminalRuntimeError({ operation, cause: error })
          )
          if (interrupted && Cause.hasDies(failed)) late.push(failed)
          resume(Effect.failCause(failed))
        }
      )
      // The caller deliberately closes the container before settle joins work.
      return Effect.sync(() => {
        interrupted = true
      })
    })
  const settle = () =>
    Effect.promise(async () => {
      while (pending.size) await Promise.allSettled([...pending])
    }).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          const failures = late.splice(0)
          return failures.length
            ? Effect.failCause(
                Cause.fromReasons(failures.flatMap((cause) => cause.reasons))
              ).pipe(orDieAll)
            : Effect.void
        })
      )
    )
  return { call, settle }
}
export function effectTerminalRuntime(
  runtime: ForeignTerminalRuntime
): TerminalRuntime {
  const { call, settle } = foreignOperations()
  const linked = (signal: AbortSignal, effectSignal: AbortSignal) =>
    AbortSignal.any([signal, effectSignal])
  return {
    close: () => call("close", () => runtime.close()),
    settle,
    restore: (bytes, signal, unrestricted) =>
      call("restore", (effectSignal) =>
        runtime.restore(bytes, linked(signal, effectSignal), unrestricted)
      ),
    execute: (command, output, signal) =>
      call("execute", (effectSignal) =>
        runtime.execute(command, output, linked(signal, effectSignal))
      ),
    snapshot: (signal) =>
      call("snapshot", (effectSignal) =>
        runtime.snapshot(linked(signal, effectSignal))
      ),
    importFile: (path, bytes, signal) =>
      call("import", (effectSignal) => {
        if (!runtime.importFile)
          return Promise.reject(new Error("Import unavailable"))
        return runtime.importFile(path, bytes, linked(signal, effectSignal))
      }),
    exportFile: (path, signal) =>
      call("export", (effectSignal) => {
        if (!runtime.exportFile)
          return Promise.reject(new Error("Export unavailable"))
        return runtime.exportFile(path, linked(signal, effectSignal))
      }),
    openInteractive: (signal) =>
      call("interactive", (effectSignal) => {
        if (!runtime.openInteractive)
          return Promise.reject(new Error("Interactive unavailable"))
        return runtime
          .openInteractive(linked(signal, effectSignal))
          .then(effectInteractiveRuntime)
      }),
  }
}
export function effectInteractiveRuntime(
  runtime: ForeignInteractiveRuntime
): InteractiveRuntime {
  const { call, settle } = foreignOperations()
  return {
    connect: (request) =>
      Effect.gen(function* () {
        let response: Response | undefined,
          accepted = false,
          transferred = false
        const accept = () => {
          const socket = response?.webSocket
          if (!socket) throw new Error("Terminal upgrade omitted its socket")
          if (!accepted) {
            socket.accept()
            accepted = true
          }
          return socket
        }
        yield* Effect.addFinalizer(() =>
          settle().pipe(
            Effect.ensuring(
              Effect.suspend(() => {
                if (!response || transferred) return Effect.void
                if (!response.webSocket) return releaseUnreadResponse(response)
                const socket = response.webSocket
                if (socket.readyState >= 2) return Effect.void
                return Effect.sync(accept).pipe(
                  Effect.asVoid,
                  Effect.ensuring(
                    Effect.sync(() => socket.close(1000, "Session ended"))
                  )
                )
              })
            )
          )
        )
        const value = yield* call("connect shell", (signal) =>
          runtime
            .connect(
              new Request(request, {
                signal: AbortSignal.any([request.signal, signal]),
              })
            )
            .then((found) => {
              response = found
              return found
            })
        )
        if (!value.webSocket)
          return yield* new TerminalRuntimeError({
            operation: "connect shell",
            cause: "Terminal upgrade omitted its socket",
          })
        return {
          accept,
          transfer: () => {
            if (!accepted)
              throw new Error(
                "Terminal socket transferred before relay acceptance"
              )
            transferred = true
          },
        }
      }),
    close: () => call("close shell", () => runtime.close()),
    settle,
  }
}
export function effectCheckpointStorage(
  storage: ForeignCheckpointStorage
): CheckpointStorage {
  const { call, settle } = foreignOperations()
  return {
    read: (checkpoint) =>
      call("read checkpoint", () => storage.read(checkpoint)),
    write: (bytes) => call("write checkpoint", () => storage.write(bytes)),
    settle,
  }
}

export const terminalFileDigest = (bytes: Uint8Array) =>
  nativeOperation(
    () => fileDigest(bytes),
    (cause) => new TerminalRuntimeError({ operation: "digest", cause })
  )
