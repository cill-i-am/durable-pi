import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { transition, type EventFromLogic } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

export const MigrationReceipt = Schema.Struct({
  owner: Schema.String,
  name: Schema.String,
  key: Schema.String,
  sha256: Schema.String,
  size: Schema.Number,
})
export type MigrationReceipt = typeof MigrationReceipt.Type
export const MigrationMarker = Schema.Struct({
  phase: Schema.Literals([
    "frozen",
    "sealed",
    "snapshot",
    "copying",
    "done",
    "moved",
  ]),
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  receipt: Schema.optional(MigrationReceipt),
  copied: Schema.optional(Schema.Number),
})
export type MigrationMarker = typeof MigrationMarker.Type
const same = (a: MigrationReceipt | undefined, b: MigrationReceipt) =>
  a &&
  a.owner === b.owner &&
  a.name === b.name &&
  a.key === b.key &&
  a.sha256 === b.sha256 &&
  a.size === b.size
function identity(marker: MigrationMarker, id: string, name: string) {
  if (marker.id !== id || marker.name !== name)
    throw new Error("Conflicting terminal migration")
}
function receipt(marker: MigrationMarker | undefined, value: MigrationReceipt) {
  if (!marker?.receipt || !same(marker.receipt, value))
    throw new Error("Conflicting terminal migration")
}

/** Existing marker data is the sole durable representation. Every decision is
 * synchronous and may execute in the same transaction as its SQL/page writes. */
export const terminalMigrationMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    context: Schema.Struct({ marker: Schema.UndefinedOr(MigrationMarker) }),
    events: {
      FREEZE: Schema.Struct({ id: Schema.String, name: Schema.String }),
      SEAL: Schema.Struct({ id: Schema.String, name: Schema.String }),
      SNAPSHOT: Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        receipt: MigrationReceipt,
      }),
      COPY: Schema.Struct({ receipt: MigrationReceipt }),
      PAGE: Schema.Struct({ receipt: MigrationReceipt, index: Schema.Number }),
      VERIFIED: Schema.Struct({
        receipt: MigrationReceipt,
        copied: Schema.Number,
      }),
      MOVE: Schema.Struct({ receipt: MigrationReceipt }),
    },
  },
}).createMachine({
  id: "terminal-migration",
  initial: "original",
  context: { marker: undefined },
  on: {
    FREEZE: ({ context, event }) => {
      const old = context.marker
      if (old) {
        if (!["frozen", "sealed", "snapshot", "moved"].includes(old.phase))
          throw new Error("Conflicting terminal migration")
        identity(old, event.id, event.name)
        return
      }
      return {
        target: ".frozen",
        context: {
          marker: { phase: "frozen", id: event.id, name: event.name },
        },
      }
    },
    SEAL: ({ context, event }) => {
      const old = context.marker
      if (
        !old ||
        !["frozen", "sealed", "snapshot", "moved"].includes(old.phase)
      )
        throw new Error("Unprepared source migration")
      identity(old, event.id, event.name)
      if (old.phase !== "frozen") return
      return {
        target: ".sealed",
        context: { marker: { ...old, phase: "sealed" } },
      }
    },
    SNAPSHOT: ({ context, event }) => {
      const old = context.marker
      if (!old || !["sealed", "snapshot", "moved"].includes(old.phase))
        throw new Error("Unprepared source migration")
      identity(old, event.id, event.name)
      if (event.receipt.name !== event.name)
        throw new Error("Conflicting terminal migration")
      if (old.phase !== "sealed") {
        receipt(old, event.receipt)
        return
      }
      return {
        target: ".snapshot",
        context: {
          marker: { ...old, phase: "snapshot", receipt: event.receipt },
        },
      }
    },
    COPY: ({ context, event }) => {
      const old = context.marker
      if (old) {
        if (old.phase !== "copying" && old.phase !== "done")
          throw new Error("Conflicting terminal migration")
        receipt(old, event.receipt)
        return
      }
      return {
        target: ".copying",
        context: {
          marker: { phase: "copying", receipt: event.receipt, copied: 0 },
        },
      }
    },
    PAGE: ({ context, event }) => {
      const old = context.marker
      if (!old || (old.phase !== "copying" && old.phase !== "done"))
        throw new Error("Unprepared target migration")
      receipt(old, event.receipt)
      if (
        !Number.isSafeInteger(event.index) ||
        event.index < 0 ||
        event.index > old.copied!
      )
        throw new Error("Migration page order mismatch")
      if (event.index < old.copied!) return
      if (old.phase === "done")
        throw new Error("Terminal migration already completed")
      return { context: { marker: { ...old, copied: event.index + 1 } } }
    },
    VERIFIED: ({ context, event }) => {
      const old = context.marker
      if (!old || (old.phase !== "copying" && old.phase !== "done"))
        throw new Error("Unprepared target migration")
      receipt(old, event.receipt)
      if (old.copied !== event.copied)
        throw new Error("Migration page count mismatch")
      return { target: ".done", context: { marker: { ...old, phase: "done" } } }
    },
    MOVE: ({ context, event }) => {
      const old = context.marker
      if (!old || (old.phase !== "snapshot" && old.phase !== "moved"))
        throw new Error("Unprepared source migration")
      receipt(old, event.receipt)
      return {
        target: ".moved",
        context: { marker: { ...old, phase: "moved" } },
      }
    },
  },
  states: {
    original: { tags: ["writable", "cancellable"] },
    frozen: { tags: ["cancellable"] },
    sealed: {},
    snapshot: {},
    copying: {},
    done: { tags: ["writable", "cancellable"] },
    moved: {},
  },
})
export function restoreTerminalMigration(raw: MigrationMarker | undefined) {
  const marker = Schema.decodeUnknownSync(Schema.UndefinedOr(MigrationMarker))(
    raw
  )
  if (marker) {
    const source = ["frozen", "sealed", "snapshot", "moved"].includes(
      marker.phase
    )
    if (source && (!marker.id || !marker.name))
      throw new Error("Invalid source migration marker")
    if (
      ["snapshot", "moved", "copying", "done"].includes(marker.phase) &&
      !marker.receipt
    )
      throw new Error("Invalid migration receipt marker")
    if (source && marker.receipt && marker.name !== marker.receipt.name)
      throw new Error("Conflicting terminal migration receipt marker")
    if (!source && (!Number.isSafeInteger(marker.copied) || marker.copied! < 0))
      throw new Error("Invalid migration page marker")
  }
  return terminalMigrationMachine.resolveState({
    value: marker?.phase ?? "original",
    context: { marker },
  })
}
export function advanceTerminalMigration(
  current: MigrationMarker | undefined,
  event: EventFromLogic<typeof terminalMigrationMachine>
) {
  const [next, effects] = transition(
    terminalMigrationMachine,
    restoreTerminalMigration(current),
    event
  )
  if (effects.length) throw new Error("Invalid terminal migration event")
  return next.context.marker!
}
