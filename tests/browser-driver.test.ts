import { runInNewContext } from "node:vm"

import { TimeoutError } from "@cloudflare/puppeteer"
import { it as effectIt } from "@effect/vitest"
import { Cause, Effect, Exit, Fiber, Layer, ManagedRuntime } from "effect"
import { TestClock } from "effect/testing"
import { beforeEach, expect, it, vi } from "vitest"

import {
  CloudflareBrowser,
  PAGE_OBSERVATION,
  SENSITIVE_FOCUS,
  SUPPORTED_FOCUS,
  MASK_FIELDS,
  UNMASK_FIELDS,
} from "../src/browser/adapters/cloudflare"
import { nativeBrowserOperation } from "../src/browser/adapters/interop"

const provider = vi.hoisted(() => ({ launch: vi.fn(), connect: vi.fn() }))
vi.mock("@cloudflare/puppeteer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cloudflare/puppeteer")>()
  return { ...actual, default: provider }
})
const session = {
  id: "synthetic-session",
  targetId: "target",
  expiresAt: Date.now() + 600_000,
}
const implementation = new CloudflareBrowser({} as BrowserRun)
const driver = {
  open: (...args: Parameters<CloudflareBrowser["open"]>) =>
    Effect.runPromise(implementation.open(...args)),
  navigate: (...args: Parameters<CloudflareBrowser["navigate"]>) =>
    Effect.runPromise(implementation.navigate(...args)),
  capture: (...args: Parameters<CloudflareBrowser["capture"]>) =>
    Effect.runPromise(implementation.capture(...args)),
  interact: (...args: Parameters<CloudflareBrowser["interact"]>) =>
    Effect.runPromise(implementation.interact(...args)),
}
beforeEach(() => {
  vi.resetAllMocks()
})
function fixture(
  value: unknown = { title: "Example", text: "Page text", links: [] },
  sensitive: unknown = false,
  supported = true
) {
  const send = vi.fn(
    async (method: string, params?: Record<string, unknown>) => {
      if (method === "Target.getTargetInfo")
        return { targetInfo: { targetId: "target" } }
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "frame" } } }
      if (method === "Page.createIsolatedWorld")
        return { executionContextId: 42 }
      if (method === "Page.stopLoading") return {}
      if (method === "Runtime.evaluate") {
        expect(params?.contextId).toBe(42)
        return {
          result: {
            value:
              params?.expression === PAGE_OBSERVATION
                ? value
                : params?.expression === SUPPORTED_FOCUS
                  ? supported
                  : sensitive,
          },
        }
      }
      throw new Error("Unexpected CDP method")
    }
  )
  const detach = vi.fn(async () => {})
  const page = {
    createCDPSession: vi.fn(async () => ({ send, detach })),
    url: () => "https://example.com/",
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    setViewport: vi.fn(
      async (_viewport: {
        width: number
        height: number
        deviceScaleFactor?: number
      }) => {}
    ),
    setRequestInterception: vi.fn(async () => {}),
    on: vi.fn(),
    off: vi.fn(),
    waitForNavigation: vi.fn(async () => null),
    goto: vi.fn(async () => null),
    mouse: { click: vi.fn(async () => {}), wheel: vi.fn(async () => {}) },
    keyboard: {
      sendCharacter: vi.fn(async () => {}),
      press: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
    },
    screenshot: vi.fn(async () => new Uint8Array([255, 216, 255, 217])),
    evaluate: vi.fn(() => {
      throw new Error("Unsafe page realm")
    }),
  }
  const browser = {
    pages: async () => [page],
    disconnect: vi.fn(async () => {}),
  }
  provider.connect.mockResolvedValue(browser)
  return { page, browser, send, detach }
}
it("observes in an isolated world and validates the host contract", async () => {
  const f = fixture()
  const result = await driver.capture(session, ["example.com"])
  expect(result.page.text).toBe("Page text")
  expect(result.screenshot).toBe("/9j/2Q==")
  expect(f.page.evaluate).not.toHaveBeenCalled()
  expect(f.send).toHaveBeenCalledWith(
    "Page.createIsolatedWorld",
    expect.objectContaining({ grantUniveralAccess: false }),
    expect.anything()
  )
  expect(f.browser.disconnect).toHaveBeenCalled()
})
it("rejects oversized or malformed remote observations before screenshots/persistence", async () => {
  const f = fixture({ title: "Page", text: "x".repeat(24_001), links: [] })
  await expect(driver.capture(session, ["example.com"])).rejects.toThrow()
  expect(f.page.screenshot).not.toHaveBeenCalled()
  expect(f.browser.disconnect).toHaveBeenCalled()
})
it("isolated observer bounds strings and links even when the page realm has poisoned prototypes", () => {
  const document = {
    createTreeWalker: () => {
      let visited = false
      return {
        nextNode: () => {
          if (visited) return null
          visited = true
          return {
            textContent: "x".repeat(2_100_000),
            parentElement: { closest: () => null, getClientRects: () => [1] },
          }
        },
      }
    },
    title: "t".repeat(1000),
    querySelector: () => ({ innerText: "x".repeat(2_100_000) }),
    querySelectorAll: () => [],
  }
  const poisoned = runInNewContext(
    `String.prototype.slice = function () { return String(this) }; ${PAGE_OBSERVATION}`,
    { document }
  )
  expect(poisoned.text.length).toBe(2_100_001)
  const isolated = runInNewContext(PAGE_OBSERVATION, { document })
  expect(isolated.title.length).toBe(200)
  expect(isolated.text.length).toBe(24_000)
})
it("prioritizes main content and product links over a whitespace-heavy retail navigation", () => {
  const main = { kind: "main" }
  const parent = { closest: () => null, getClientRects: () => [{}] }
  const link = (name: string) => ({
    innerText: name,
    href: `https://example.com/${name}`,
    closest: () => null,
    querySelector: () => null,
  })
  const product = link("headphones")
  const document = {
    title: "Shop",
    querySelector: (selector: string) =>
      selector.startsWith("main") ? main : { kind: "body" },
    createTreeWalker: (root: unknown) => {
      const nodes = (
        root === main
          ? [
              " ".repeat(24000),
              "Headphones €79.99",
              " Battery   life: 35 hours ",
            ]
          : ["Navigation ".repeat(5000)]
      ).map((textContent) => ({ textContent, parentElement: parent }))
      return { nextNode: () => nodes.shift() }
    },
    querySelectorAll: (selector: string) =>
      selector.startsWith("main")
        ? [product]
        : [...Array.from({ length: 100 }, (_, i) => link(`nav${i}`)), product],
  }
  const result = runInNewContext(PAGE_OBSERVATION, { document })
  expect(result.text).toBe("Headphones €79.99\nBattery life: 35 hours\n")
  expect(result.links[0]).toEqual({
    text: "headphones",
    url: "https://example.com/headphones",
  })
  expect(result.links).toHaveLength(20)
})
it("discards a page that navigated during its screenshot", async () => {
  const f = fixture()
  f.page.screenshot.mockImplementation(async () => {
    f.page.url = () => "https://example.com/changed"
    return new Uint8Array(4)
  })
  await expect(driver.capture(session, ["example.com"])).rejects.toThrow(
    "navigated"
  )
})
it("fails closed and closes Chromium when network guardrails are not confirmed", async () => {
  const browser = {
    newPage: async () => ({
      goto: async () => ({ status: () => 200, headers: () => ({}) }),
    }),
    close: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
  }
  provider.launch.mockResolvedValue(browser)
  await expect(driver.open(["example.com"])).rejects.toThrow(
    "destination restrictions"
  )
  expect(browser.close).toHaveBeenCalled()
  expect(browser.disconnect).toHaveBeenCalled()
})

it.each([true, null, "false"])(
  "blocks model typing when isolated focus check is unsafe (%s)",
  async (sensitive) => {
    const f = fixture(undefined, sensitive)
    await expect(
      driver.interact(
        session,
        { kind: "type", text: "synthetic" },
        "https://example.com/",
        ["example.com"],
        "agent"
      )
    ).rejects.toThrow("owner control")
    expect(f.page.keyboard.sendCharacter).not.toHaveBeenCalled()
    expect(f.page.evaluate).not.toHaveBeenCalled()
  }
)
it("lets the owner type privately through native input and captures no input value", async () => {
  const f = fixture(undefined, true)
  const capture = await driver.interact(
    session,
    { kind: "type", text: "synthetic-private-input" },
    "https://example.com/",
    ["example.com"],
    "owner"
  )
  expect(f.page.keyboard.sendCharacter).toHaveBeenCalledExactlyOnceWith(
    "synthetic-private-input"
  )
  expect(JSON.stringify(capture)).not.toContain("synthetic-private-input")
  expect(f.page.evaluate).not.toHaveBeenCalled()
})
it("rejects actions when the native page changed since the approved capture", async () => {
  const f = fixture()
  await expect(
    driver.interact(
      session,
      { kind: "click", x: 40, y: 80 },
      "https://example.com/old",
      ["example.com"],
      "agent"
    )
  ).rejects.toThrow("navigated")
  expect(f.page.mouse.click).not.toHaveBeenCalled()
})
it("clicks native coordinates and bounds navigation waiting", async () => {
  const f = fixture()
  await driver.interact(
    session,
    { kind: "click", x: 40, y: 80 },
    "https://example.com/",
    ["example.com"],
    "agent"
  )
  expect(f.page.mouse.click).toHaveBeenCalledExactlyOnceWith(40, 80)
  expect(f.page.waitForNavigation).toHaveBeenCalledWith(
    expect.objectContaining({ timeout: 2000 })
  )
  expect(f.page.setRequestInterception).toHaveBeenCalledWith(true)
})
it("restores the advertised viewport on each reconnect before delivering coordinates", async () => {
  const f = fixture()
  let viewport = { width: 800, height: 600 }
  provider.connect.mockImplementation(async () => {
    viewport = { width: 800, height: 600 }
    return f.browser
  })
  f.page.setViewport.mockImplementation(async (value) => {
    viewport = value
  })
  f.page.mouse.click.mockImplementation(async () => {
    expect(viewport).toMatchObject({ width: 1024, height: 768 })
  })
  await driver.capture(session, ["example.com"])
  await driver.interact(
    session,
    { kind: "click", x: 900, y: 700 },
    "https://example.com/",
    ["example.com"],
    "agent"
  )
  expect(f.page.setViewport).toHaveBeenCalledTimes(2)
  expect(f.page.mouse.click).toHaveBeenCalledExactlyOnceWith(900, 700)
})
it("keeps a delivered click recoverable when navigation changes during its screenshot", async () => {
  const f = fixture()
  f.page.screenshot.mockImplementationOnce(async () => {
    f.page.url = () => "https://example.com/product"
    return new Uint8Array([255, 216, 255, 217])
  })
  await expect(
    driver.interact(
      session,
      { kind: "click", x: 40, y: 80 },
      "https://example.com/",
      ["example.com"],
      "agent"
    )
  ).rejects.toMatchObject({
    _tag: "BrowserFailure",
    outcome: "failed",
    message: expect.stringContaining("input was sent"),
  })
  await expect(driver.capture(session, ["example.com"])).resolves.toMatchObject(
    { page: { url: "https://example.com/product" } }
  )
  expect(f.page.mouse.click).toHaveBeenCalledTimes(1)
})
it("does not confirm input when its native delivery fails", async () => {
  const f = fixture()
  f.page.mouse.click.mockRejectedValue(new Error("Lost input connection"))
  await expect(
    driver.interact(
      session,
      { kind: "click", x: 40, y: 80 },
      "https://example.com/",
      ["example.com"],
      "agent"
    )
  ).rejects.toMatchObject({ _tag: "BrowserUnavailable" })
  expect(f.page.screenshot).not.toHaveBeenCalled()
})
it("releases modifier keys even when selection fails", async () => {
  const f = fixture()
  f.page.keyboard.press.mockRejectedValue(new Error("Disconnected"))
  await expect(
    driver.interact(
      session,
      { kind: "key", key: "SelectAll" },
      "https://example.com/",
      ["example.com"],
      "owner"
    )
  ).rejects.toMatchObject({ _tag: "BrowserUnavailable" })
  expect(f.page.keyboard.up).toHaveBeenCalledExactlyOnceWith("Control")
})

it.each([
  { tagName: "INPUT", type: "password", autocomplete: "" },
  { tagName: "INPUT", type: "text", autocomplete: "ONE-TIME-CODE" },
  { tagName: "SECRET-ENTRY", shadowRoot: null },
  { tagName: "IFRAME" },
])(
  "classifies normalized secrets and unknown focus conservatively: %j",
  (element) => {
    expect(
      runInNewContext(SENSITIVE_FOCUS, { document: { activeElement: element } })
    ).toBe(true)
  }
)
it("restores capture masks after screenshot failure", async () => {
  const f = fixture()
  f.page.screenshot.mockRejectedValue(new Error("Snapshot failed"))
  await expect(driver.capture(session, ["example.com"])).rejects.toMatchObject({
    _tag: "BrowserUnavailable",
  })
  const expressions = f.send.mock.calls
    .filter(([method]) => method === "Runtime.evaluate")
    .map(([, params]) => params?.expression)
  expect(expressions).toEqual([PAGE_OBSERVATION, MASK_FIELDS, UNMASK_FIELDS])
})
it("masks ordinary, revealed-password and OTP field values and restores existing styles", () => {
  const styles = new Map([["-webkit-text-security", "none"]])
  const element = {
    matches: () => true,
    style: {
      getPropertyValue: (key: string) => styles.get(key) || "",
      getPropertyPriority: () => "important",
      setProperty: (key: string, value: string) => styles.set(key, value),
      removeProperty: (key: string) => styles.delete(key),
    },
  }
  const context = { document: { querySelectorAll: () => [element] } }
  runInNewContext(MASK_FIELDS, context)
  expect(styles.get("-webkit-text-security")).toBe("disc")
  runInNewContext(UNMASK_FIELDS, context)
  expect(styles.get("-webkit-text-security")).toBe("none")
})

it("refuses owner text in iframe or closed-shadow focus before native input", async () => {
  const f = fixture(undefined, true, false)
  await expect(
    driver.interact(
      session,
      { kind: "type", text: "private synthetic" },
      "https://example.com/",
      ["example.com"],
      "owner"
    )
  ).rejects.toThrow("embedded frames")
  expect(f.page.keyboard.sendCharacter).not.toHaveBeenCalled()
})

it("omits provider allowlists and the restriction probe only for unrestricted sessions", async () => {
  const goto = vi.fn(async () => null)
  const browser = {
    newPage: async () => ({
      goto,
      setViewport: vi.fn(async () => {}),
      createCDPSession: async () => ({
        send: async () => ({ targetInfo: { targetId: "target" } }),
        detach: vi.fn(async () => {}),
      }),
    }),
    sessionId: () => "unrestricted-session",
    close: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
  }
  provider.launch.mockResolvedValue(browser)
  expect((await driver.open([], true)).id).toBe("unrestricted-session")
  expect(provider.launch.mock.calls[0]![1]).not.toHaveProperty("guardrails")
  expect(goto).toHaveBeenCalledExactlyOnceWith("about:blank")
})

it("still uses isolated observation in unrestricted sessions", async () => {
  const f = fixture()
  await expect(driver.capture(session, [], true)).resolves.toMatchObject({
    page: { text: "Page text" },
  })
  expect(f.page.evaluate).not.toHaveBeenCalled()
})

it.each(["429", "403"])(
  "reports launch HTTP %s without exposing the provider body",
  async (status) => {
    provider.launch.mockRejectedValue(
      new Error(
        `Unable to create new browser: code: ${status}: message: synthetic-private-body`
      )
    )
    await expect(driver.open([], true)).rejects.toMatchObject({
      outcome: "rejected",
      message: expect.stringContaining(
        status === "429" ? "limit" : "permissions"
      ),
    })
    await expect(driver.open([], true)).rejects.not.toThrow(
      "synthetic-private-body"
    )
    expect(provider.connect).not.toHaveBeenCalled()
  }
)
it("a lost session reconnect is a confirmed rejection before page dispatch", async () => {
  provider.connect.mockRejectedValue(
    new Error("Unable to connect to existing session private-handle")
  )
  await expect(
    driver.navigate(session, "https://example.com", [], true)
  ).rejects.toMatchObject({
    outcome: "rejected",
    message: expect.stringContaining("no longer available"),
  })
})

it("records Chromium's native navigation error document as a confirmed failed load", async () => {
  const f = fixture()
  f.page.goto.mockImplementation(async () => {
    f.page.url = () => "chrome-error://chromewebdata/"
    return null
  })
  await expect(
    driver.navigate(session, "https://x.com", [], true)
  ).rejects.toMatchObject({
    outcome: "failed",
    message: expect.stringContaining("could not load the page"),
  })
  expect(f.page.goto).toHaveBeenCalledOnce()
  expect(f.page.screenshot).not.toHaveBeenCalled()
  expect(f.browser.disconnect).toHaveBeenCalled()
})

it.each([
  "ERR_NAME_NOT_RESOLVED",
  "ERR_CONNECTION_CLOSED",
  "ERR_CONNECTION_TIMED_OUT",
])(
  "settles a native navigation %s as a failed load without exposing its URL",
  async (code) => {
    const f = fixture()
    f.page.goto.mockRejectedValue(
      new Error(`net::${code} at https://example.com/?private=synthetic-secret`)
    )
    await expect(
      driver.navigate(session, "https://example.com", [], true)
    ).rejects.toMatchObject({
      outcome: "failed",
      message: expect.stringContaining(code),
    })
    await expect(
      driver.navigate(session, "https://example.com", [], true)
    ).rejects.not.toThrow("synthetic-secret")
    expect(f.page.screenshot).not.toHaveBeenCalled()
    expect(f.browser.disconnect).toHaveBeenCalled()
  }
)

it("keeps an unknown navigation failure uncertain", async () => {
  const f = fixture()
  f.page.goto.mockRejectedValue(new Error("Connection closed during dispatch"))
  await expect(
    driver.navigate(session, "https://example.com", [], true)
  ).rejects.not.toHaveProperty("outcome")
})

it("stops a timed-out navigation before settling its failed load", async () => {
  const f = fixture()
  f.page.goto.mockRejectedValue(new TimeoutError("Navigation timeout exceeded"))
  await expect(
    driver.navigate(session, "https://example.com", [], true)
  ).rejects.toMatchObject({
    outcome: "failed",
    message: expect.stringContaining("Loading was stopped"),
  })
  expect(f.send).toHaveBeenCalledWith("Page.stopLoading", undefined, {
    timeout: 5000,
  })
  expect(f.page.goto).toHaveBeenCalledOnce()
  expect(f.page.screenshot).not.toHaveBeenCalled()
})

it("keeps a navigation uncertain when stopping its load is unconfirmed", async () => {
  const f = fixture()
  f.page.goto.mockRejectedValue(new TimeoutError("Navigation timeout exceeded"))
  const send = f.send.getMockImplementation()!
  f.send.mockImplementation(async (method, params) => {
    if (method === "Page.stopLoading")
      throw new Error("Connection closed before stop was confirmed")
    return send(method, params)
  })
  await expect(
    driver.navigate(session, "https://example.com", [], true)
  ).rejects.not.toHaveProperty("outcome")
  expect(f.page.goto).toHaveBeenCalledOnce()
})

it("reports delivered input without claiming success from a subsequent error document", async () => {
  const f = fixture()
  f.page.mouse.click.mockImplementation(async () => {
    f.page.url = () => "chrome-error://chromewebdata/"
  })
  const action = driver.interact(
    session,
    { kind: "click", x: 1, y: 1 },
    "https://example.com/",
    [],
    "agent",
    true
  )
  await expect(action).rejects.toMatchObject({ _tag: "BrowserFailure" })
  await expect(action).rejects.toMatchObject({
    outcome: "failed",
    message: expect.stringContaining("input was sent"),
  })
  expect(f.page.mouse.click).toHaveBeenCalledOnce()
  expect(f.browser.disconnect).toHaveBeenCalled()
})

function gate() {
  let release!: () => void
  const waiting = new Promise<void>((done) => {
    release = done
  })
  return { waiting, release }
}

it("joins failed target discovery's CDP detach before disconnecting", async () => {
  const f = fixture(),
    cleaning = gate(),
    release = gate()
  let settled = false
  f.send.mockRejectedValue(new Error("Private target lookup failure"))
  f.detach.mockImplementation(async () => {
    cleaning.release()
    await release.waiting
  })
  const work = Effect.runPromiseExit(implementation.capture(session, [])).then(
    (exit) => {
      settled = true
      return exit
    }
  )
  await cleaning.waiting
  expect(settled).toBe(false)
  expect(f.browser.disconnect).not.toHaveBeenCalled()
  release.release()
  const exit = await work
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(false)
  expect(f.detach).toHaveBeenCalledOnce()
  expect(f.browser.disconnect).toHaveBeenCalledOnce()
})

it("retains both target lookup failure and a CDP cleanup defect", async () => {
  const f = fixture()
  f.send.mockRejectedValue(new Error("Private target lookup failure"))
  f.detach.mockRejectedValue(new Error("Private CDP release failure"))
  const exit = await Effect.runPromiseExit(implementation.capture(session, []))
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  if (Exit.isFailure(exit)) {
    const defects = exit.cause.reasons.flatMap((reason) =>
      reason._tag === "Die" ? [reason.defect] : []
    )
    expect(defects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ _tag: "BrowserUnavailable" }),
        expect.objectContaining({ message: "Private CDP release failure" }),
      ])
    )
  }
  expect(f.browser.disconnect).toHaveBeenCalledOnce()
})

it("failed acquisition joins close and disconnect even when close rejects", async () => {
  const closing = gate(),
    close = gate(),
    disconnecting = gate(),
    disconnect = gate()
  const browser = {
    newPage: vi.fn(async () => {
      throw new Error("Private new-page failure")
    }),
    close: vi.fn(async () => {
      closing.release()
      await close.waiting
      throw new Error("Private close failure")
    }),
    disconnect: vi.fn(async () => {
      disconnecting.release()
      await disconnect.waiting
    }),
  }
  provider.launch.mockResolvedValue(browser)
  let settled = false
  const work = Effect.runPromiseExit(implementation.open([], true)).then(
    (exit) => {
      settled = true
      return exit
    }
  )
  await closing.waiting
  expect(settled).toBe(false)
  close.release()
  await disconnecting.waiting
  expect(settled).toBe(false)
  disconnect.release()
  const exit = await work
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  expect(browser.close).toHaveBeenCalledOnce()
  expect(browser.disconnect).toHaveBeenCalledOnce()
})

it("does not hand off a session after successful acquisition's disconnect fails", async () => {
  const f = fixture(),
    browser = {
      newPage: async () => ({ ...f.page, setViewport: async () => {} }),
      sessionId: () => session.id,
      close: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {
        throw new Error("Private disconnect failure")
      }),
    }
  provider.launch.mockResolvedValue(browser)
  const exit = await Effect.runPromiseExit(implementation.open([], true))
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  expect(browser.close).toHaveBeenCalledOnce()
  expect(f.detach).toHaveBeenCalledOnce()
})

it.each(["allowed", "blocked", "failed"])(
  "joins the %s navigation interceptor and removes its handler",
  async (destination) => {
    const f = fixture(),
      entered = gate(),
      release = gate(),
      removed = gate(),
      frame = {}
    const request = {
      isInterceptResolutionHandled: () => false,
      interceptResolutionState: () => ({ action: "none" }),
      isNavigationRequest: () => true,
      frame: () => frame,
      url: () =>
        destination === "blocked"
          ? "https://outside.org/"
          : "https://example.com/",
      continue: vi.fn(async () => {
        entered.release()
        await release.waiting
        if (destination === "failed")
          throw new Error("Private interception failure")
      }),
      abort: vi.fn(async () => {
        entered.release()
        await release.waiting
      }),
    }
    Object.assign(f.page, { mainFrame: () => frame })
    f.page.goto.mockImplementation(async () => {
      const handler = f.page.on.mock.calls[0]![1]
      handler(request)
      return null
    })
    f.page.off.mockImplementation(() => {
      removed.release()
    })
    let settled = false
    const work = Effect.runPromiseExit(
      implementation.navigate(session, "https://example.com", ["example.com"])
    ).then((exit) => {
      settled = true
      return exit
    })
    await entered.waiting
    await removed.waiting
    expect(settled).toBe(false)
    expect(f.browser.disconnect).not.toHaveBeenCalled()
    release.release()
    const exit = await work
    expect(Exit.isSuccess(exit)).toBe(destination !== "failed")
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(
      destination === "failed"
    )
    expect(
      destination === "blocked" ? request.abort : request.continue
    ).toHaveBeenCalledOnce()
    expect(f.page.off).toHaveBeenCalledWith(
      "request",
      f.page.on.mock.calls[0]![1]
    )
    expect(f.browser.disconnect).toHaveBeenCalledOnce()
  }
)

it("joins a navigation watcher after native click failure", async () => {
  const f = fixture(),
    clicked = gate(),
    finish = gate()
  f.page.waitForNavigation.mockImplementation(async () => {
    await finish.waiting
    return null
  })
  f.page.mouse.click.mockImplementation(async () => {
    clicked.release()
    throw new Error("Private click failure")
  })
  let settled = false
  const work = Effect.runPromiseExit(
    implementation.interact(
      session,
      { kind: "click", x: 1, y: 1 },
      "https://example.com/",
      [],
      "agent",
      true
    )
  ).then((exit) => {
    settled = true
    return exit
  })
  await clicked.waiting
  expect(settled).toBe(false)
  finish.release()
  const exit = await work
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(false)
  expect(f.browser.disconnect).toHaveBeenCalledOnce()
})

for (const failed of [false, true])
  effectIt.effect(
    `timeout disconnect is joined exactly once and retains failure=${failed}`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = fixture(),
            deadline = gate(),
            release = gate(),
            observed = gate(),
            disconnecting = gate()
          let settled = false
          const send = f.send.getMockImplementation()!
          f.send.mockImplementation(async (method, params) => {
            if (
              method === "Runtime.evaluate" &&
              params?.expression === PAGE_OBSERVATION
            ) {
              observed.release()
              await deadline.waiting
            }
            return send(method, params)
          })
          f.browser.disconnect.mockImplementation(async () => {
            disconnecting.release()
            deadline.release()
            await release.waiting
            if (failed) throw new Error("Private deadline disconnect failure")
          })
          const fiber = yield* implementation
            .capture(session, ["example.com"])
            .pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  settled = true
                })
              ),
              Effect.forkScoped
            )
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              deadline.release()
              release.release()
            })
          )
          yield* Effect.promise(() => observed.waiting)
          const advancing = yield* TestClock.adjust("30 seconds").pipe(
            Effect.forkScoped
          )
          yield* Effect.promise(() => disconnecting.waiting)
          yield* Effect.yieldNow
          expect(f.browser.disconnect).toHaveBeenCalledOnce()
          expect(settled).toBe(false)
          release.release()
          const exit = yield* Fiber.await(fiber)
          yield* Fiber.join(advancing)
          expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(failed)
          expect(f.browser.disconnect).toHaveBeenCalledOnce()
        })
      )
  )

it("actor disposal joins a late CDP acquisition, detach and disconnect before releasing its Layer", async () => {
  const f = fixture(),
    acquiring = gate(),
    acquired = gate(),
    detaching = gate(),
    detached = gate(),
    events: string[] = []
  f.page.createCDPSession.mockImplementation(async () => {
    acquiring.release()
    await acquired.waiting
    return { send: f.send, detach: f.detach }
  })
  f.detach.mockImplementation(async () => {
    detaching.release()
    await detached.waiting
    events.push("cdp.detached")
  })
  f.browser.disconnect.mockImplementation(async () => {
    events.push("browser.disconnected")
  })
  const actor = ManagedRuntime.make(
    Layer.effectDiscard(
      Effect.addFinalizer(() =>
        Effect.sync(() => {
          events.push("layer.closed")
        })
      )
    )
  )
  const work = actor.runPromiseExit(implementation.capture(session, []))
  await acquiring.waiting
  let disposed = false
  const disposing = actor.dispose().then(() => {
    disposed = true
  })
  acquired.release()
  await detaching.waiting
  expect(disposed).toBe(false)
  expect(events).not.toContain("layer.closed")
  detached.release()
  const exit = await work
  await disposing
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  expect(events).toEqual([
    "cdp.detached",
    "browser.disconnected",
    "layer.closed",
  ])
  expect(f.detach).toHaveBeenCalledOnce()
})

it("closes malformed session acquisition before it can enter durable state", async () => {
  const f = fixture(),
    browser = {
      newPage: async () => ({ ...f.page, setViewport: async () => {} }),
      sessionId: () => undefined,
      close: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
    }
  provider.launch.mockResolvedValue(browser)
  const exit = await Effect.runPromiseExit(implementation.open([], true))
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  expect(browser.close).toHaveBeenCalledOnce()
  expect(browser.disconnect).toHaveBeenCalledOnce()
})

it("ignores requests created before interception was enabled", async () => {
  const f = fixture(),
    request = {
      isInterceptResolutionHandled: () => false,
      interceptResolutionState: () => ({ action: "disabled" }),
      continue: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    }
  f.page.goto.mockImplementation(async () => {
    f.page.on.mock.calls[0]![1](request)
    return null
  })
  await Effect.runPromise(
    implementation.navigate(session, "https://example.com", ["example.com"])
  )
  expect(request.continue).not.toHaveBeenCalled()
  expect(request.abort).not.toHaveBeenCalled()
  expect(f.page.off).toHaveBeenCalledOnce()
})

it("retains native rejection interpretation defects in the Effect cause", async () => {
  const exit = await Effect.runPromiseExit(
    nativeBrowserOperation(
      async () => {
        throw new Error("Native failure")
      },
      () => {
        throw new TypeError("Interpreter defect")
      }
    )
  )
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
})

it.each(["navigate", "capture", "interact"])(
  "keeps %s destination rejection in the typed channel and cleans its connection",
  async (operation) => {
    const f = fixture()
    f.page.url = () => "https://outside.org/"
    const work =
      operation === "navigate"
        ? implementation.navigate(session, "https://outside.org", [
            "example.com",
          ])
        : operation === "capture"
          ? implementation.capture(session, ["example.com"])
          : implementation.interact(
              session,
              { kind: "click", x: 1, y: 1 },
              "https://example.com/",
              ["example.com"],
              "agent"
            )
    expect(await Effect.runPromise(work.pipe(Effect.result))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "BrowserFailure" },
    })
    expect(f.page.goto).not.toHaveBeenCalled()
    expect(f.page.mouse.click).not.toHaveBeenCalled()
    expect(f.browser.disconnect).toHaveBeenCalledOnce()
  }
)

it.each(["timeout", "rejection"])(
  "settles a click navigation watcher %s through the browser error channel",
  async (mode) => {
    const f = fixture()
    f.page.waitForNavigation.mockRejectedValue(
      mode === "timeout"
        ? new TimeoutError("navigation timed out")
        : new Error("Private navigation failure")
    )
    const work = driver.interact(
      session,
      { kind: "click", x: 1, y: 1 },
      "https://example.com/",
      ["example.com"],
      "agent"
    )
    if (mode === "timeout")
      await expect(work).resolves.toMatchObject({
        page: { url: "https://example.com/" },
      })
    else await expect(work).rejects.toThrow()
    expect(f.browser.disconnect).toHaveBeenCalledOnce()
  }
)
