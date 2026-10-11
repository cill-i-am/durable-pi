import { runInNewContext } from "node:vm"
import { beforeEach, expect, it, vi } from "vitest"
import {
  CloudflareBrowser,
  PAGE_OBSERVATION,
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
  value: unknown = { title: "Example", text: "Page text", links: [] }
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
        expect(params?.expression).toBe(PAGE_OBSERVATION)
        return { result: { value } }
      }
      throw new Error("Unexpected CDP method")
    }
  )
  const page = {
    createCDPSession: async () => ({ send, detach: vi.fn() }),
    url: () => "https://example.com/",
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
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
    title: "t".repeat(1000),
    querySelector: () => ({ innerText: "x".repeat(2_100_000) }),
    querySelectorAll: () => [],
  }
  const poisoned = runInNewContext(
    `String.prototype.slice = function () { return String(this) }; ${PAGE_OBSERVATION}`,
    { document }
  )
  expect(poisoned.text.length).toBe(2_100_000)
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
