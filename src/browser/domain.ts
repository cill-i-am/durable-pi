import { Schema } from "effect"
import {
  BrowserController,
  BrowserFailure,
  BrowserPage,
  BrowserPolicy,
  BrowserState,
  type BrowserRecord,
} from "./contracts"

export const BrowserSessionRecord = Schema.Struct({
  id: Schema.String,
  targetId: Schema.String,
  expiresAt: Schema.Number,
  idleExpiresAt: Schema.optionalKey(Schema.Number),
})
export const BrowserCaptureRecord = Schema.Struct({
  page: BrowserPage,
  screenshot: Schema.NullOr(
    Schema.String.check(Schema.isMaxLength(128 * 1024))
  ),
})
export const BrowserRecordSchema = Schema.Struct({
  controller: BrowserController,
  generation: BrowserPolicy.fields.generation,
  hosts: BrowserPolicy.fields.hosts,
  unrestricted: Schema.Boolean,
  version: BrowserPolicy.fields.generation,
  status: BrowserState.fields.status,
  session: Schema.NullOr(BrowserSessionRecord),
  capture: Schema.NullOr(BrowserCaptureRecord),
  error: Schema.NullOr(Schema.String),
})
export const initialBrowser = (): BrowserRecord => ({
  controller: "agent",
  generation: 0,
  hosts: [],
  unrestricted: true,
  version: 0,
  status: "closed",
  session: null,
  capture: null,
  error: null,
})
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
export function updateBrowser(
  record: BrowserRecord,
  generation: number,
  patch: Partial<
    Pick<BrowserRecord, "status" | "session" | "capture" | "error">
  >
): BrowserRecord {
  requireBrowserGeneration(record, generation)
  return { ...record, ...patch, version: record.version + 1 }
}
export function resetBrowser(
  record: BrowserRecord,
  generation: number,
  hosts: readonly string[],
  unrestricted = false
): BrowserRecord {
  requireBrowserGeneration(record, generation)
  return {
    controller: "agent",
    generation: generation + 1,
    hosts: [...new Set(hosts)],
    unrestricted,
    version: record.version + 1,
    status: "closed",
    session: null,
    capture: null,
    error: null,
  }
}
export function transferBrowser(
  record: BrowserRecord,
  generation: number,
  controller: typeof BrowserController.Type
): BrowserRecord {
  requireBrowserGeneration(record, generation, true)
  return {
    ...record,
    controller,
    generation: generation + 1,
    version: record.version + 1,
    status: "loading",
    capture: null,
    error: null,
  }
}
