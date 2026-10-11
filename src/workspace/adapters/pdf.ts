import { Effect } from "effect"
import { getResolvedPDFJS } from "unpdf"
import {
  DocumentUnreadable,
  PDF_PAGE_LIMIT,
  PDF_TEXT_LIMIT,
  type ExtractedDocument,
} from "../documents"

export { PDF_PAGE_LIMIT, PDF_TEXT_LIMIT } from "../documents"

/** Text only: never render PDF scripts, follow links, or fetch external fonts/assets. */
export const extractPdf = (bytes: Uint8Array) =>
  Effect.tryPromise({
    try: async (signal): Promise<ExtractedDocument> => {
      const { getDocument } = await getResolvedPDFJS()
      signal.throwIfAborted()
      const loading = getDocument({
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
      let cleanup: Promise<void> | undefined
      const destroy = () => (cleanup ??= loading.destroy())
      const abort = () => {
        void destroy().catch(() => {})
      }
      signal.addEventListener("abort", abort, { once: true })
      let text = "",
        readPages = 0
      try {
        const pdf = await loading.promise
        let truncated = pdf.numPages > PDF_PAGE_LIMIT
        for (
          let number = 1;
          number <= Math.min(pdf.numPages, PDF_PAGE_LIMIT);
          number++
        ) {
          const page = await pdf.getPage(number)
          const reader = page
            .streamTextContent({ disableNormalization: false })
            .getReader()
          let pageText = ""
          try {
            // Drain the page after the cap: early cancel races PDF.js's inline worker stream close.
            for (;;) {
              const result = await reader.read()
              if (result.done) break
              for (const item of result.value.items) {
                if ("str" in item) {
                  const remaining = Math.max(
                    0,
                    PDF_TEXT_LIMIT - text.length - pageText.length
                  )
                  const value = item.str + (item.hasEOL ? "\n" : " ")
                  pageText += value.slice(0, remaining)
                  if (value.length > remaining) truncated = true
                }
              }
            }
          } finally {
            reader.releaseLock()
            page.cleanup()
          }
          readPages = number
          if (pageText.trim())
            text += `\n[Page ${number}]\n${pageText.trim()}\n`
          if (text.length >= PDF_TEXT_LIMIT) {
            text = text.slice(0, PDF_TEXT_LIMIT)
            truncated = true
            break
          }
        }
        return { text: text.trim(), pages: pdf.numPages, readPages, truncated }
      } finally {
        signal.removeEventListener("abort", abort)
        await destroy()
      }
    },
    catch: (cause) =>
      new DocumentUnreadable({
        reason:
          cause instanceof Error && cause.name === "PasswordException"
            ? "encrypted"
            : "invalid",
      }),
  })
