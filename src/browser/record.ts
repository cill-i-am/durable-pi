import { Schema } from "effect"

import {
  BrowserController,
  BrowserPage,
  BrowserPolicy,
  BrowserState,
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
const legacyFields = {
  controller: BrowserController,
  generation: BrowserPolicy.fields.generation,
  hosts: BrowserPolicy.fields.hosts,
  unrestricted: Schema.Boolean,
  version: BrowserPolicy.fields.generation,
  status: BrowserState.fields.status,
  session: Schema.NullOr(BrowserSessionRecord),
  capture: Schema.NullOr(BrowserCaptureRecord),
  error: Schema.NullOr(Schema.String),
}
export const BrowserRecordSchema = Schema.Struct({
  ...legacyFields,
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  attemptId: Schema.NullOr(Schema.String),
})
const LegacyRecord = Schema.Struct({
  ...legacyFields,
  controller: Schema.optionalKey(BrowserController),
  unrestricted: Schema.optionalKey(Schema.Boolean),
})
export function restoreBrowserRecord(value: unknown) {
  if (typeof value !== "object" || value === null)
    throw new Error("Invalid browser record")
  if (
    "schemaVersion" in value ||
    "workflowVersion" in value ||
    "attemptId" in value
  )
    return Schema.decodeUnknownSync(BrowserRecordSchema)(value)
  const legacy = Schema.decodeUnknownSync(LegacyRecord)(value)
  return Schema.decodeUnknownSync(BrowserRecordSchema)({
    ...legacy,
    controller: legacy.controller ?? "agent",
    unrestricted: legacy.unrestricted ?? false,
    schemaVersion: 1,
    workflowVersion: 1,
    attemptId:
      legacy.status === "loading"
        ? `legacy:${legacy.generation}:${legacy.version}`
        : null,
  })
}
