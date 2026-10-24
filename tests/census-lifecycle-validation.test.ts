import { Deferred, Effect } from "effect"
import { expect, it } from "vitest"
import { initialTransition, transition } from "xstate"

import { sessionFetchMachine } from "../src/auth/session-fetch.machine"
import { conversationObserverMachine } from "../src/conversations/event-observer.machine"
import { handoffObserverMachine } from "../src/conversations/handoff-observer.machine"
import { catalogMachine } from "../src/inference/catalog.machine"
import { decideCapacity } from "../src/terminal/capacity.machine"
import {
  advanceTerminalMigration,
  restoreTerminalMigration,
} from "../src/terminal/migration.machine"
import { nativeOwnerMachine } from "../src/terminal/native-owner.machine"

it("rejects malformed auth requests before launching native work", () => {
  const machine = sessionFetchMachine({
    now: () => 0,
    launch: () => Effect.die("must not launch"),
  })
  const [state] = initialTransition(machine)
  const [next, effects] = transition(machine, state, {
    type: "READ",
    request: { reply: Deferred.makeUnsafe() },
  } as never)
  expect(next.context).toEqual(state.context)
  expect(effects).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "@xstate.deadLetter",
        reason: "invalidEvent",
      }),
    ])
  )
})
it("rejects malformed catalog and observer events at the official boundary", () => {
  const [state] = initialTransition(catalogMachine)
  const [next, effects] = transition(catalogMachine, state, {
    type: "READ",
    identity: 4,
    now: "later",
    reply: Deferred.makeUnsafe(),
  } as never)
  expect(next.context).toEqual(state.context)
  expect(effects).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "@xstate.deadLetter",
        reason: "invalidEvent",
      }),
    ])
  )
  const observer = conversationObserverMachine({
    changed: Effect.never,
    active: Effect.succeed(undefined),
    watch: () => Effect.void,
    release: Effect.void,
    snapshot: Effect.never,
    publish: () => Effect.never,
    heartbeat: Effect.never,
  })
  const [observing] = initialTransition(observer)
  const [same, rejected] = transition(observer, observing, {
    type: "UNKNOWN",
  } as never)
  expect(same.value).toEqual(observing.value)
  expect(rejected).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "@xstate.deadLetter",
        reason: "invalidEvent",
      }),
    ])
  )
})

it("rejects malformed diagnostic and native-owner messages before their effects", () => {
  const handoff = handoffObserverMachine({
    admit: Effect.succeed(true),
    admitted: () => Effect.void,
    control: Effect.void,
    heartbeat: Effect.void,
    confirm: Effect.never,
    ended: Effect.never,
  })
  const owner = nativeOwnerMachine({
    acquire: () => Effect.void,
    start: () => Effect.void,
    close: Effect.void,
    retire: () => Effect.succeed(true),
  })
  for (const [machine, event] of [
    [handoff, { type: "TRANSFER", ack: 42 }],
    [
      owner,
      {
        type: "START",
        unrestricted: "yes",
        signal: undefined,
        reply: Deferred.makeUnsafe(),
      },
    ],
  ] as const) {
    const [state] = initialTransition(machine)
    const [next, effects] = transition(machine, state, event as never)
    expect(next.context).toEqual(state.context)
    expect(effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "@xstate.deadLetter",
          reason: "invalidEvent",
        }),
      ])
    )
  }
})
const lease = { owner: "a".repeat(64), epoch: 1, issuedAt: 0 }
it.each([
  { next: 0, leases: [] },
  { next: 1.5, leases: [] },
  { next: 2, leases: [lease, lease] },
  { next: 2, leases: [{ ...lease, epoch: 2 }] },
  { next: 2, leases: [{ ...lease, owner: "not-an-owner" }] },
])(
  "rejects incompatible capacity data without allocating from it: %j",
  (current) => {
    expect(() =>
      decideCapacity(current, {
        type: "ACQUIRE",
        owner: "b".repeat(64),
        now: 1,
      })
    ).toThrow()
  }
)
const receipt = {
  owner: lease.owner,
  name: "pi-synthetic",
  key: `terminal-migration/${lease.owner}/fixture/manifest.json`,
  sha256: "b".repeat(64),
  size: 8,
}
it("restores compatible cutover data and rejects malformed and conflicting progression", () => {
  const copying = advanceTerminalMigration(undefined, { type: "COPY", receipt })
  expect(
    restoreTerminalMigration(JSON.parse(JSON.stringify(copying))).value
  ).toBe("copying")
  expect(() =>
    advanceTerminalMigration(copying, {
      type: "PAGE",
      receipt,
      index: "0",
    } as never)
  ).toThrow("Invalid")
  expect(() =>
    advanceTerminalMigration(copying, { type: "PAGE", receipt, index: 1 })
  ).toThrow("order")
  expect(() =>
    advanceTerminalMigration(copying, {
      type: "PAGE",
      receipt: { ...receipt, sha256: "c".repeat(64) },
      index: 0,
    })
  ).toThrow("Conflicting")
  const first = advanceTerminalMigration(copying, {
    type: "PAGE",
    receipt,
    index: 0,
  })
  expect(
    advanceTerminalMigration(first, { type: "PAGE", receipt, index: 0 })
  ).toEqual(first)
  expect(() =>
    advanceTerminalMigration(first, { type: "VERIFIED", receipt, copied: 2 })
  ).toThrow("count")
  const done = advanceTerminalMigration(first, {
    type: "VERIFIED",
    receipt,
    copied: 1,
  })
  expect(() =>
    advanceTerminalMigration(done, { type: "MOVE", receipt })
  ).toThrow("Unprepared")
  expect(() => restoreTerminalMigration({ phase: "future" } as never)).toThrow()
  expect(() =>
    restoreTerminalMigration({ phase: "copying", receipt, copied: -1 })
  ).toThrow()
  expect(() =>
    restoreTerminalMigration({
      phase: "snapshot",
      id: "test",
      name: "pi-other",
      receipt,
    })
  ).toThrow()
})
