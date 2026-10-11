import { runInNewContext } from "node:vm"
import { beforeEach, expect, it, vi } from "vitest"
import {
  CloudflareBrowser,
  PAGE_OBSERVATION,
  SENSITIVE_FOCUS,
  SUPPORTED_FOCUS,
  MASK_FIELDS,
  UNMASK_FIELDS,
} from "../src/browser/adapters/cloudflare"

const provider = vi.hoisted(() => ({ launch: vi.fn(), connect: vi.fn() }))
vi.mock("@cloudflare/puppeteer", () => ({ default: provider }))
const session = {
  id: "synthetic-session",
  targetId: "target",
  expiresAt: Date.now() + 600_000,
}
const driver = new CloudflareBrowser({} as BrowserRun)
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
  const page = {
    createCDPSession: async () => ({ send, detach: vi.fn() }),
    url: () => "https://example.com/",
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    setRequestInterception: vi.fn(async () => {}),
    on: vi.fn(),
    waitForNavigation: vi.fn(async () => null),
    mouse: { click: vi.fn(async () => {}), wheel: vi.fn(async () => {}) },
    keyboard: {
      sendCharacter: vi.fn(async () => {}),
      press: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
    },
    screenshot: vi.fn(async () => new Uint8Array([255, 216, 255, 217])),
    // Production must never execute observation in the site's realm.
    evaluate: vi.fn(() => {
      throw new Error("Unsafe page realm")
    }),
  }
  const browser = {
    pages: async () => [page],
    disconnect: vi.fn(async () => {}),
  }
  provider.connect.mockResolvedValue(browser)
  return { page, browser, send }
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
  ).rejects.toThrow("Disconnected")
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
  await expect(driver.capture(session, ["example.com"])).rejects.toThrow(
    "Snapshot failed"
  )
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
