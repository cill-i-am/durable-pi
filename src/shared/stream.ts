import { Cause, Effect, Schema, Stream } from "effect"

import { orDieAll } from "./effect"
import { nativeFailure, nativeOperation } from "./interop"

/** Own the reader and join read/cancel before releasing its lock. */
export const nativeByteStream = <TError>(
  open: () => ReadableStream<unknown>,
  onReadError: () => TError
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      let ended = false
      let cancellation: Promise<void> | undefined
      const cancel = (reader: ReadableStreamDefaultReader<unknown>) =>
        nativeOperation(
          () => (cancellation ??= reader.cancel()),
          (cause) => {
            throw cause
          }
        )
      const reader = yield* Effect.acquireRelease(
        Effect.sync(() => open().getReader()),
        (value) =>
          (ended ? Effect.void : cancel(value)).pipe(
            Effect.ensuring(Effect.sync(() => value.releaseLock()))
          )
      )
      const read = Effect.callback<
        ReadableStreamReadResult<Uint8Array>,
        TError
      >((resume) => {
        const work = reader.read()
        let failed: Cause.Cause<TError> | undefined
        let delivered = false
        work.then(
          (next) => {
            ended = next.done
            if (next.done)
              resume(Effect.succeed({ done: true, value: undefined }))
            else if (Schema.is(Schema.Uint8Array)(next.value))
              resume(Effect.succeed({ done: false, value: next.value }))
            else resume(Effect.fail(onReadError()))
          },
          (cause) => {
            ended = true
            const failure = nativeFailure(cause, onReadError)
            failed = failure
            resume(
              Effect.suspend(() => {
                delivered = true
                return Effect.failCause(failure)
              })
            )
          }
        )
        return Effect.suspend(() =>
          ended ? Effect.void : cancel(reader)
        ).pipe(
          Effect.ensuring(
            Effect.promise(() =>
              work.then(
                () => undefined,
                () => undefined
              )
            ).pipe(
              Effect.andThen(
                Effect.suspend(() =>
                  !delivered && failed && Cause.hasDies(failed)
                    ? Effect.failCause(failed).pipe(orDieAll)
                    : Effect.void
                )
              )
            )
          )
        )
      })
      return Stream.unfold(undefined, () =>
        read.pipe(
          Effect.map((next) =>
            next.done ? undefined : ([next.value, undefined] as const)
          )
        )
      )
    })
  )

export const nativeBytes = <TReadError, TLimitError>(
  body: ReadableStream<unknown>,
  maximum: number,
  onReadError: () => TReadError,
  onTooLarge: () => TLimitError
) =>
  Effect.suspend(() => {
    let length = 0
    return Stream.mkUint8Array(
      nativeByteStream(() => body, onReadError).pipe(
        Stream.mapEffect((part) => {
          length += part.byteLength
          return length > maximum
            ? Effect.fail(onTooLarge())
            : Effect.succeed(part)
        })
      )
    )
  })
