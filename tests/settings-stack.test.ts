import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  defaultStringifySearch,
} from "@tanstack/react-router"
import { describe, expect, it } from "vitest"

import {
  settingsFrames,
  settingsPush,
  settingsPop,
  settingsBackdrop,
  settingsRoute,
  readSettingsHistory,
  workspaceNavigationContext,
  readWorkspaceNavigation,
} from "../src/navigation/settings-stack"
import { workspaceRouteSearch } from "../src/navigation/workspace"

describe("settings drawer stack", () => {
  it.each([
    ["/settings", ["settings"]],
    ["/settings/security", ["settings", "security"]],
    ["/family/model-access", ["settings", "family", "model-access"]],
    ["/agents/research/settings", ["agent-settings"]],
    ["/agents/research/settings/models", ["agent-settings", "models"]],
  ])(
    "mounts deterministic list and parent frames for direct %s",
    (href, categories) => {
      expect(
        settingsFrames(href as string).map((frame) => frame.category)
      ).toEqual(categories)
    }
  )

  it("keeps frame identity stable when callback or backdrop query state changes", () => {
    const first = settingsFrames(
      "/settings/connections?connections=connected&returnTo=%2Fagents%2Fhome"
    )
    const next = settingsFrames(
      "/settings/connections?returnTo=%2Fagents%2Fnavi"
    )
    expect(first.map((frame) => frame.id)).toEqual(
      next.map((frame) => frame.id)
    )
    expect(settingsRoute("/agents/research/settings/")?.id).toBe(
      settingsRoute("/agents/research/settings")?.id
    )
  })

  it("preserves resource identity and filters as the root exit destination", () => {
    expect(
      settingsBackdrop(
        "/agents/research/settings/models?panel=terminal&item=command%3A1&tab=interactive"
      )
    ).toBe("/agents/research/terminal/command%3A1?tab=interactive")
    expect(
      settingsBackdrop(
        "/settings/security?returnTo=%2Fagents%2Fresearch%2Ffiles%3Ftab%3Dtrash"
      )
    ).toBe("/agents/research/files?tab=trash")
  })

  it("uses real history for an owned push, but replaces one ancestor for direct links", () => {
    const state = settingsPush("/settings", "/family", {
      entryKey: "root",
      entryIndex: 2,
    })
    expect(
      settingsPop("/family", {
        settings: state.piSettings,
        entryKey: "family",
        entryIndex: 3,
      })
    ).toEqual({ kind: "back" })
    const direct = settingsPop("/family/model-access", {})
    expect(direct).toMatchObject({ kind: "replace", href: "/family" })
    if (direct.kind !== "replace")
      throw new Error("Expected one direct-link ancestor.")
    const second = settingsPop(direct.href, {
      settings: direct.state.piSettings,
    })
    expect(second).toMatchObject({ kind: "replace", href: "/settings" })
    expect(settingsPop("/settings", {})).toEqual({ kind: "close" })
  })

  it("keeps actual cross-scope parents and selects only an existing parent prefix", () => {
    const current = "/agents/research/settings/connections"
    const state = settingsPush(
      current,
      "/settings/connections",
      { entryKey: "agent", entryIndex: 3 },
      undefined,
      "/agents/research/terminal"
    )
    expect(
      settingsFrames("/settings/connections", state.piSettings).map(
        (frame) => frame.category
      )
    ).toEqual(["agent-settings", "connections", "connection-library"])
    expect(state.piSettings.backdrop).toBe("/agents/research/terminal")
    const frames = settingsFrames("/settings/connections", state.piSettings)
    const sibling = settingsPush(
      "/settings/connections",
      "/agents/research/settings/skills",
      { settings: state.piSettings, entryKey: "library", entryIndex: 4 },
      frames[0]
    )
    expect(
      settingsFrames(
        "/agents/research/settings/skills",
        sibling.piSettings
      ).map((frame) => frame.category)
    ).toEqual(["agent-settings", "skills"])
    expect(sibling.piSettings.from).toBeUndefined()
    expect(() =>
      settingsPush(current, "/family", {}, settingsRoute("/settings")!)
    ).toThrow("no longer mounted")
  })

  it("does not go back from a newer pending history entry using an older presented frame", () => {
    const state = settingsPush("/settings", "/family", {
      entryKey: "root",
      entryIndex: 2,
    })
    expect(
      settingsPop(
        "/family",
        { settings: state.piSettings, entryKey: "family", entryIndex: 3 },
        { entryKey: "pending-model-access", entryIndex: 4 }
      )
    ).toMatchObject({ kind: "replace", href: "/settings" })
  })

  it.each([
    { version: 2, parents: [] },
    { version: 1, parents: ["https://evil.example/settings"] },
    { version: 1, parents: ["/api/agent/send"] },
    { version: 1, parents: ["/agents/new"] },
    { version: 1, parents: ["/settings/preferences"] },
    { version: 1, parents: ["/settings", "/settings"] },
    { version: 1, parents: Array(16).fill("/settings") },
  ])(
    "rejects invalid history metadata without turning it into navigation authority",
    (history) => {
      expect(readSettingsHistory(history)).toBeUndefined()
      expect(
        settingsFrames("/family", readSettingsHistory(history)).map(
          (frame) => frame.category
        )
      ).toEqual(["settings", "family"])
    }
  )

  it("captures a validated immutable history snapshot with the committed match", () => {
    const raw = {
      __TSR_key: "family",
      __TSR_index: 3,
      piSettings: {
        version: 1,
        parents: ["/settings"],
        backdrop: "https://evil.example",
      },
    }
    const context = workspaceNavigationContext({ location: { state: raw } })
    raw.piSettings.parents[0] = "/settings/preferences"
    const snapshot = readWorkspaceNavigation(context)
    expect(snapshot).toMatchObject({
      entryKey: "family",
      entryIndex: 3,
      settings: { parents: ["/settings"], backdrop: undefined },
    })
  })
})

it("round-trips nested settings and parent metadata through native Back/Forward and reload", async () => {
  const root = createRootRoute({ beforeLoad: workspaceNavigationContext })
  const paths = ["/settings", "/family", "/family/model-access"]
  const router = createRouter({
    routeTree: root.addChildren(
      paths.map((path) =>
        createRoute({
          getParentRoute: () => root,
          path,
          validateSearch: (input) => workspaceRouteSearch(path, input),
        })
      )
    ),
    history: createMemoryHistory({ initialEntries: ["/settings"] }),
    isServer: true,
  })
  await router.load()
  for (const path of paths.slice(1)) {
    const match = router.state.matches.at(-1)!
    const navigation = readWorkspaceNavigation(match.context)
    const state = settingsPush(
      match.pathname + defaultStringifySearch(match.search),
      path,
      navigation
    )
    router.history.push(path, state)
    await router.load()
  }
  let match = router.state.matches.at(-1)!
  let navigation = readWorkspaceNavigation(match.context)
  expect(
    settingsFrames(match.pathname, navigation.settings).map(
      (frame) => frame.category
    )
  ).toEqual(["settings", "family", "model-access"])
  expect(settingsPop(match.pathname, navigation)).toEqual({ kind: "back" })
  await router.load()
  expect(
    readWorkspaceNavigation(router.state.matches.at(-1)!.context).settings
      ?.parents
  ).toEqual(["/settings", "/family"])
  router.history.back()
  await router.load()
  match = router.state.matches.at(-1)!
  navigation = readWorkspaceNavigation(match.context)
  expect(match.pathname).toBe("/family")
  expect(
    settingsFrames(match.pathname, navigation.settings).map(
      (frame) => frame.category
    )
  ).toEqual(["settings", "family"])
  router.history.forward()
  await router.load()
  expect(router.state.matches.at(-1)?.pathname).toBe("/family/model-access")
  expect(
    readWorkspaceNavigation(router.state.matches.at(-1)!.context).settings
      ?.parents
  ).toEqual(["/settings", "/family"])
})
