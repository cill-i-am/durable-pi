import { Cause, Effect, Exit, Latch, Stream } from "effect"
import type { Scope } from "effect"

import type { FileError } from "../files"
import type { FileContent } from "../workspace"

export type FileBodyRunner = (
  work: Effect.Effect<void, FileError>,
  options: { signal: AbortSignal }
) => Promise<Exit.Exit<void, FileError>>

/** A genuine native response boundary. The retained runner owns acquisition,
 * demand, consumption and cleanup after the request has returned its headers. */
export const fileDownload = (
  content: Effect.Effect<FileContent, FileError, Scope.Scope>,
  request: Request,
  inline: (file: FileContent) => boolean,
  run: FileBodyRunner = Effect.runPromiseExit
) =>
  Effect.gen(function* () {
    const invocation = yield* Effect.context<never>()
    return yield* Effect.callback<Response, FileError>((resume, signal) => {
      const cancelled = new AbortController(),
        demand = Latch.makeUnsafe()
      let sent = false,
        closed = false
      let pulled: (() => void) | undefined
      let controller!: ReadableStreamDefaultController<Uint8Array>
      const body = new ReadableStream<Uint8Array>(
        {
          start(value) {
            controller = value
          },
          pull() {
            return new Promise<void>((resolve) => {
              pulled = resolve
              demand.openUnsafe()
            })
          },
          async cancel() {
            closed = true
            cancelled.abort()
            const exit = await task
            if (Exit.isFailure(exit) && Cause.hasDies(exit.cause))
              throw new Error("File download cleanup failed.")
          },
        },
        { highWaterMark: 0 }
      )
      const program = Effect.scoped(
        Effect.gen(function* () {
          const file = yield* content
          const response = new Response(body, {
            headers: {
              "content-type": file.mime,
              "content-disposition": `${inline(file) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.info.name).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16)}`)}`,
              "cache-control": "private, no-store",
              "x-content-type-options": "nosniff",
              "content-security-policy": "default-src 'none'; sandbox",
              "referrer-policy": "no-referrer",
            },
          })
          sent = true
          resume(Effect.succeed(response))
          yield* file.body.pipe(
            Stream.runForEach((chunk) =>
              demand.whenOpen(
                Effect.sync(() => {
                  demand.closeUnsafe()
                  if (!closed) controller.enqueue(chunk)
                  pulled?.()
                  pulled = undefined
                })
              )
            )
          )
        })
      ).pipe(Effect.provideContext(invocation))
      const task = run(program, {
        signal: AbortSignal.any([request.signal, cancelled.signal]),
      })
      void task.then((exit) => {
        pulled?.()
        pulled = undefined
        if (!sent) {
          if (Exit.isFailure(exit)) resume(Effect.failCause(exit.cause))
          else resume(Effect.die(new Error("File response was not published")))
        }
        if (closed) return
        closed = true
        if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause))
          controller.error(new Error("The file could not be read."))
        else controller.close()
      })
      return Effect.promise(async () => {
        // Before headers, this request owns the producer. Afterwards, the body
        // and retained actor runner own it; abort/cancel still joins cleanup.
        if (!sent || signal.aborted) {
          cancelled.abort()
          await task
        }
      })
    })
  })
