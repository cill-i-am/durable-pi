import { Effect, Schema } from "effect"
import { getResolvedPDFJS } from "unpdf"

import {
  DocumentUnreadable,
  PDF_PAGE_LIMIT,
  PDF_TEXT_LIMIT,
} from "../documents"

export { PDF_PAGE_LIMIT, PDF_TEXT_LIMIT } from "../documents"

const parserError = Schema.is(Schema.Struct({ name: Schema.String }))
// PDF.js rejects native Promises. Only documented input failures are recoverable.
const parserFailure = (cause: unknown) =>
  parserError(cause) && cause.name === "PasswordException"
    ? Effect.fail(new DocumentUnreadable({ reason: "encrypted" }))
    : parserError(cause) &&
        [
          "InvalidPDFException",
          "UnknownErrorException",
          "FormatError",
        ].includes(cause.name)
      ? Effect.fail(new DocumentUnreadable({ reason: "invalid" }))
      : Effect.die(cause)

const parserCall = <T>(
  start: () => Promise<T>,
  cancel: () => Promise<unknown>
) =>
  Effect.callback<T, DocumentUnreadable>((resume) => {
    let work: Promise<T>
    try {
      work = start()
    } catch (cause) {
      resume(Effect.die(cause))
      return
    }
    work.then(
      (value) => resume(Effect.succeed(value)),
      (cause) => resume(parserFailure(cause))
    )
    return Effect.promise(async () => {
      await Promise.all([
        cancel(),
        work.then(
          () => undefined,
          () => undefined
        ),
      ])
    })
  })

export const extractPdf = (bytes: Uint8Array) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { getDocument } = yield* parserCall(
        () => getResolvedPDFJS(),
        async () => {}
      )
      let cleanup: Promise<void> | undefined
      const loading = yield* Effect.acquireRelease(
        Effect.sync(() =>
          getDocument({
            data: new Uint8Array(bytes),
            verbosity: 0,
            useWorkerFetch: false,
            useSystemFonts: false,
            disableFontFace: true,
            disableAutoFetch: true,
            disableStream: true,
            disableRange: true,
            standardFontDataUrl: undefined,
            cMapUrl: undefined,
            wasmUrl: undefined,
            stopAtErrors: true,
          })
        ),
        (task) => Effect.promise(() => (cleanup ??= task.destroy()))
      )
      const destroy = () => (cleanup ??= loading.destroy())
      const pdf = yield* parserCall(() => loading.promise, destroy)
      let text = "",
        readPages = 0,
        truncated = pdf.numPages > PDF_PAGE_LIMIT
      for (
        let number = 1;
        number <= Math.min(pdf.numPages, PDF_PAGE_LIMIT);
        number++
      ) {
        const pageText = yield* Effect.scoped(
          Effect.gen(function* () {
            let page: Awaited<ReturnType<typeof pdf.getPage>> | undefined
            // A noncooperative getPage may finish after interruption.
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                page?.cleanup()
              })
            )
            const current = yield* parserCall(
              () =>
                pdf.getPage(number).then((value) => {
                  page = value
                  return value
                }),
              destroy
            )
            let ended = false,
              cancellation: Promise<void> | undefined
            const reader = yield* Effect.acquireRelease(
              Effect.sync(() =>
                current
                  .streamTextContent({ disableNormalization: false })
                  .getReader()
              ),
              (value) =>
                (ended
                  ? Effect.void
                  : Effect.promise(() => (cancellation ??= value.cancel()))
                ).pipe(Effect.ensuring(Effect.sync(() => value.releaseLock())))
            )
            let value = ""
            for (;;) {
              const result = yield* parserCall(
                () => reader.read(),
                async () => {
                  await Promise.all([
                    (cancellation ??= reader.cancel()),
                    destroy(),
                  ])
                }
              )
              ended = result.done
              if (result.done) break
              for (const item of Schema.decodeUnknownSync(
                Schema.Struct({ items: Schema.Array(Schema.Unknown) })
              )(result.value).items) {
                if (
                  Schema.is(
                    Schema.Struct({
                      str: Schema.String,
                      hasEOL: Schema.optional(Schema.Boolean),
                    })
                  )(item)
                ) {
                  const remaining = Math.max(
                    0,
                    PDF_TEXT_LIMIT - text.length - value.length
                  )
                  const part = item.str + (item.hasEOL ? "\n" : " ")
                  value += part.slice(0, remaining)
                  if (part.length > remaining) truncated = true
                }
              }
            }
            return value
          })
        )
        readPages = number
        if (pageText.trim()) text += `\n[Page ${number}]\n${pageText.trim()}\n`
        if (text.length >= PDF_TEXT_LIMIT) {
          text = text.slice(0, PDF_TEXT_LIMIT)
          truncated = true
          break
        }
      }
      return { text: text.trim(), pages: pdf.numPages, readPages, truncated }
    })
  )
