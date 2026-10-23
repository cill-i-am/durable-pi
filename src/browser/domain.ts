import { BrowserFailure, type BrowserRecord } from "./contracts"

export {
  BrowserCaptureRecord,
  BrowserRecordSchema,
  BrowserSessionRecord,
} from "./record"
export { initialBrowser } from "./session.machine"

export function requireBrowserGeneration(
  record: BrowserRecord,
  generation: number,
  control = false
) {
  if (record.generation !== generation)
    throw new BrowserFailure({
      message: control
        ? "Browser control changed. Reload before continuing."
        : "Browser settings changed. Reload before continuing.",
    })
}
