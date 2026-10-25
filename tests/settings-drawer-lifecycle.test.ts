import { it } from "@effect/vitest"
import { createEffectActor, send, waitFor } from "@xstate/effect"
import { Deferred, Effect } from "effect"
import { expect } from "vitest"

import {
  settingsDrawersMachine,
  settingsPrefix,
} from "../src/app/settings-drawers.machine"
import { settingsOwnerMachine } from "../src/app/settings-owner.machine"
import { makeSettingsDrawers } from "../src/app/use-settings-drawers"
import type { SettingsFrame } from "../src/navigation/settings-stack"

const root: SettingsFrame = {
  id: "/settings",
  href: "/settings",
  category: "settings",
}
const account: SettingsFrame = {
  id: "/settings/account",
  href: "/settings/account",
  category: "account",
}
const security: SettingsFrame = {
  id: "/settings/security",
  href: "/settings/security",
  category: "security",
}
const route = { href: account.href, frames: [root, account], locked: false }

it.effect(
  "route replacement retains outgoing bodies until closure and rejects a stale acknowledgement after reopening",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeSettingsDrawers(route, () => route)
      yield* send(owner.actor, {
        type: "ROUTE",
        href: security.href,
        frames: [root, security],
        locked: false,
      })
      const outgoing = yield* waitFor(
        owner.actor,
        (state) => state.context.route.href === security.href
      )
      expect(outgoing.context.rendered).toEqual([root, account])
      expect(
        settingsPrefix(outgoing.context.rendered, outgoing.context.route.frames)
      ).toBe(1)
      yield* send(owner.actor, { type: "ROUTE", ...route })
      yield* send(owner.actor, {
        type: "CLOSED",
        id: account.id,
        revision: outgoing.context.revision,
      })
      yield* Effect.yieldNow
      expect(owner.actor.getSnapshot().context.rendered).toEqual([
        root,
        account,
      ])
      yield* send(owner.actor, {
        type: "ROUTE",
        href: security.href,
        frames: [root, security],
        locked: false,
      })
      const replaced = yield* waitFor(
        owner.actor,
        (state) => state.context.route.href === security.href
      )
      yield* send(owner.actor, {
        type: "CLOSED",
        id: account.id,
        revision: outgoing.context.revision,
      })
      yield* Effect.yieldNow
      expect(owner.actor.getSnapshot().context.rendered).toEqual([
        root,
        account,
      ])
      yield* send(owner.actor, {
        type: "CLOSED",
        id: account.id,
        revision: replaced.context.revision,
      })
      yield* waitFor(
        owner.actor,
        (state) => state.context.rendered[1]?.id === security.id
      )
      expect(owner.actor.getSnapshot().context.rendered).toEqual([
        root,
        security,
      ])
    }).pipe(Effect.scoped)
)

it.effect(
  "only the matching root close dispatches the captured exit once",
  () =>
    Effect.gen(function* () {
      const owner = yield* makeSettingsDrawers(route, () => route)
      const calls: string[] = []
      yield* send(owner.actor, {
        type: "EXIT",
        action: () => {
          calls.push("original")
        },
      })
      const closing = yield* waitFor(owner.actor, (state) =>
        state.matches("closing")
      )
      yield* send(owner.actor, {
        type: "EXIT",
        action: () => {
          calls.push("replacement")
        },
      })
      yield* send(owner.actor, {
        type: "CLOSED",
        id: "unknown",
        revision: closing.context.revision,
      })
      yield* send(owner.actor, {
        type: "CLOSED",
        id: account.id,
        revision: closing.context.revision,
      })
      yield* Effect.yieldNow
      expect(calls).toEqual([])
      expect(owner.actor.getSnapshot().context.rendered).toEqual([root])
      yield* send(owner.actor, {
        type: "CLOSED",
        id: root.id,
        revision: closing.context.revision,
      })
      yield* waitFor(owner.actor, (state) => state.matches("closed"))
      yield* send(owner.actor, {
        type: "CLOSED",
        id: root.id,
        revision: closing.context.revision,
      })
      yield* Effect.yieldNow
      expect(calls).toEqual(["original"])
    }).pipe(Effect.scoped)
)

for (const reason of ["locked", "route", "unmounted"] as const) {
  it.effect(
    `fresh ${reason} authority prevents a previously admitted exit`,
    () =>
      Effect.gen(function* () {
        let latest = route,
          calls = 0
        const owner = yield* makeSettingsDrawers(route, () => latest)
        yield* send(owner.actor, {
          type: "EXIT",
          action: () => {
            calls++
          },
        })
        const closing = yield* waitFor(owner.actor, (state) =>
          state.matches("closing")
        )
        if (reason === "locked") latest = { ...route, locked: true }
        if (reason === "route") latest = { ...route, href: "/family" }
        if (reason === "unmounted") owner.revoke()
        yield* send(owner.actor, {
          type: "CLOSED",
          id: root.id,
          revision: closing.context.revision,
        })
        yield* waitFor(owner.actor, (state) => state.matches("closed"))
        expect(calls).toBe(0)
      }).pipe(Effect.scoped)
  )
}

it.effect(
  "a route arriving during the captured navigation is retained after completion",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>()
      const owner = yield* createEffectActor(
        settingsDrawersMachine({
          navigate: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release))
            ),
        }),
        { input: route }
      )
      yield* send(owner, { type: "EXIT", action: () => undefined })
      const closing = yield* waitFor(owner, (state) => state.matches("closing"))
      yield* send(owner, {
        type: "CLOSED",
        id: root.id,
        revision: closing.context.revision,
      })
      yield* Deferred.await(entered)
      yield* send(owner, {
        type: "ROUTE",
        href: security.href,
        frames: [root, security],
        locked: false,
      })
      yield* waitFor(
        owner,
        (state) => state.context.route.href === security.href
      )
      yield* Deferred.succeed(release, undefined)
      yield* waitFor(owner, (state) => state.matches("active"))
      expect(owner.getSnapshot().context.rendered).toEqual([root, security])
    }).pipe(Effect.scoped)
)

it.effect(
  "retained agent ownership releases only after the outgoing settings stack closes",
  () =>
    Effect.gen(function* () {
      const owner = yield* createEffectActor(settingsOwnerMachine, {
        input: { id: "first", shown: true },
      })
      yield* send(owner, { type: "VIEW", id: "second", shown: true })
      yield* waitFor(owner, (state) => state.matches("retained"))
      expect(owner.getSnapshot().context.id).toBe("first")
      yield* send(owner, { type: "VIEW", id: null, shown: true })
      yield* Effect.yieldNow
      expect(owner.getSnapshot().context.id).toBe("first")
      yield* send(owner, { type: "VIEW", id: null, shown: false })
      yield* waitFor(owner, (state) => state.matches("current"))
      expect(owner.getSnapshot().context.id).toBeNull()
      yield* send(owner, { type: "VIEW", id: "second", shown: false })
      yield* waitFor(owner, (state) => state.context.id === "second")
    }).pipe(Effect.scoped)
)
