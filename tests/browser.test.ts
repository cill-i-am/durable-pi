import { describe, expect, it, vi } from "vitest"
import { Effect, Schema } from "effect"
import { BrowserWorkspace, type BrowserDriver } from "../src/browser/browser"
import { BrowserStore } from "../src/browser/adapters/sqlite"
import {
  BrowserPolicy,
  Hostname,
  allowedBrowserUrl,
  browserState,
  type BrowserCapture,
  type BrowserSession,
} from "../src/browser/contracts"
import { browserRequest } from "../src/browser/http"
import { database } from "./database"

const capture: BrowserCapture = {
  page: {
    url: "https://example.com/",
    title: "Example",
    text: "Untrusted page text",
    links: [],
    capturedAt: 1,
  },
  screenshot: "c3ludGhldGlj",
}
function fixture() {
  const db = database(),
    repository = new BrowserStore(db)
  const closed: string[] = [],
    visits: string[] = []
  let writable = true,
    wakes = 0
  const driver: BrowserDriver = {
    open: async () => ({
      id: crypto.randomUUID(),
      targetId: "target-synthetic",
      expiresAt: Date.now() + 600_000,
    }),
    navigate: async (_session, url) => {
      visits.push(url)
      return capture
    },
    capture: async () => capture,
    close: async (id) => {
      closed.push(id)
    },
  }
  const browser = new BrowserWorkspace(
    repository,
    driver,
    () => writable,
    async () => {
      wakes++
    }
  )
  return {
    db,
    repository,
    driver,
    browser,
    closed,
    visits,
    archive: () => {
      writable = false
    },
    wakes: () => wakes,
  }
}
const run = Effect.runPromise
const policy = { generation: 0, hosts: ["example.com"] }

describe("per-bot browser authority and lifetime", () => {
  it.each([
    "localhost",
    "127.0.0.1",
    "[::1]",
    "metadata.internal",
    "a.local",
    "*.example.com",
    "EXAMPLE.COM",
    "https://example.com",
    "foo..com",
    "-bad.com",
    "bad-.com",
    "example.com:443",
  ])("rejects unsupported hostname %s", (hostname) =>
    expect(() => Schema.decodeUnknownSync(Hostname)(hostname)).toThrow()
  )
  it("enforces exact HTTPS destinations without credentials or custom ports", () => {
    expect(
      allowedBrowserUrl("https://EXAMPLE.com/path?q=1", ["example.com"])
    ).toBe("https://example.com/path?q=1")
    for (const url of [
      "http://example.com",
      "https://www.example.com",
      "https://example.com.evil.com",
      "https://me:secret@example.com",
      "https://example.com:8443",
      "file:///etc/passwd",
      "data:text/html,hi",
      "javascript:alert(1)",
    ])
      expect(() => allowedBrowserUrl(url, ["example.com"])).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(BrowserPolicy)({
        generation: 0,
        hosts: Array.from({ length: 21 }, () => "example.com"),
      })
    ).toThrow()
  })
  it("isolates policies and sessions, reuses one session, and exposes no session credentials in state", async () => {
    const a = fixture(),
      b = fixture()
    await run(a.browser.configure(policy))
    await run(a.browser.inspect(1, "https://example.com"))
    const id = a.repository.read().session!.id
    await run(a.browser.inspect(1))
    expect(a.repository.read().session!.id).toBe(id)
    expect(a.browser.state()).toMatchObject({
      status: "ready",
      hasScreenshot: true,
      page: capture.page,
    })
    expect(JSON.stringify(a.browser.state())).not.toContain(id)
    expect(JSON.stringify(a.browser.state())).not.toContain(capture.screenshot)
    expect(b.browser.state()).toMatchObject({
      policy: { generation: 0, hosts: [] },
      status: "closed",
    })
    await expect(
      run(b.browser.inspect(0, "https://example.com"))
    ).rejects.toThrow("allowed")
    expect(b.visits).toEqual([])
    expect(new BrowserStore(a.db).read().session?.id).toBe(id)
  })
  it("fences revocation during acquisition and retires the late session", async () => {
    const f = fixture()
    await run(f.browser.configure(policy))
    let deliver!: (session: BrowserSession) => void
    f.driver.open = () =>
      new Promise((resolve) => {
        deliver = resolve
      })
    const opening = run(f.browser.inspect(1, "https://example.com"))
    await Promise.resolve()
    await run(f.browser.close(1))
    deliver({
      id: "late-session",
      targetId: "synthetic",
      expiresAt: Date.now() + 60_000,
    })
    await expect(opening).rejects.toThrow("changed")
    expect(f.visits).toEqual([])
    expect(f.repository.retired()).toEqual(["late-session"])
    await run(f.browser.cleanup())
    expect(f.closed).toEqual(["late-session"])
    expect(f.browser.state()).toMatchObject({ status: "closed", page: null })
  })
  it("fences revocation during navigation and does not publish stale page content", async () => {
    const f = fixture()
    await run(f.browser.configure(policy))
    f.driver.navigate = async () => {
      await run(f.browser.close(1))
      return capture
    }
    await expect(
      run(f.browser.inspect(1, "https://example.com"))
    ).rejects.toThrow("changed")
    expect(f.browser.state()).toMatchObject({
      status: "closed",
      page: null,
      hasScreenshot: false,
    })
    await run(f.browser.cleanup())
    expect(f.closed).toHaveLength(1)
    await expect(run(f.browser.configure(policy))).rejects.toThrow("changed")
  })
  it("retries session cleanup durably and expires sessions across reconstruction", async () => {
    const f = fixture()
    await run(f.browser.configure(policy))
    await run(f.browser.inspect(1, "https://example.com"))
    const session = f.repository.read().session!
    f.repository.update(1, { session: { ...session, expiresAt: 1 } })
    expect(browserState(new BrowserStore(f.db).read()).status).toBe("expired")
    f.driver.close = async () => {
      throw new Error("private provider error")
    }
    const retry = await run(f.browser.cleanup())
    expect(retry).toBeGreaterThan(Date.now())
    expect(f.repository.retired()).toEqual([session.id])
    expect(f.repository.read().session).toBeNull()
    f.driver.close = async () => {}
    expect(await run(f.browser.cleanup())).toBeUndefined()
    expect(f.repository.retired()).toEqual([])
  })
  it("rejects archived bot actions and cleans its session", async () => {
    const f = fixture()
    await run(f.browser.configure(policy))
    await run(f.browser.inspect(1, "https://example.com"))
    f.archive()
    await expect(run(f.browser.inspect(1))).rejects.toThrow("archived")
    await expect(
      run(f.browser.configure({ ...policy, generation: 1 }))
    ).rejects.toThrow("archived")
    await run(f.browser.cleanup())
    expect(f.closed).toHaveLength(1)
  })
  it("renews idle time before inspection without extending the absolute deadline", async () => {
    let now = Date.now()
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now)
    try {
      const f = fixture()
      await run(f.browser.configure(policy))
      await run(f.browser.inspect(1, "https://example.com"))
      const absolute = f.repository.read().session!.expiresAt
      now = f.repository.read().session!.idleExpiresAt! - 100
      f.driver.capture = async () => {
        now += 200
        await run(f.browser.cleanup())
        return capture
      }
      await run(f.browser.inspect(1))
      expect(f.closed).toEqual([])
      expect(f.browser.state().status).toBe("ready")
      expect(f.repository.read().session!.expiresAt).toBe(absolute)
      now = f.repository.read().session!.idleExpiresAt! + 1
      expect(f.browser.state().status).toBe("expired")
      await run(f.browser.cleanup())
      expect(f.closed).toHaveLength(1)
    } finally {
      clock.mockRestore()
    }
  })
  it("serializes browser operations so one tab cannot be driven concurrently", async () => {
    const f = fixture()
    await run(f.browser.configure(policy))
    let running = 0,
      maximum = 0
    f.driver.navigate = async () => {
      maximum = Math.max(maximum, ++running)
      await new Promise((resolve) => setTimeout(resolve, 5))
      running--
      return capture
    }
    await Promise.all([
      run(f.browser.inspect(1, "https://example.com/a")),
      run(f.browser.inspect(1, "https://example.com/b")),
    ])
    expect(maximum).toBe(1)
  })
  it("does not dispatch a queued action after its reply stops", async () => {
    const f = fixture()
    await run(f.browser.configure(policy))
    let start!: () => void
    const started = new Promise<void>((resolve) => {
      start = resolve
    })
    let finish!: () => void
    f.driver.navigate = async (_session, url) => {
      f.visits.push(url)
      start()
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return capture
    }
    const first = run(f.browser.inspect(1, "https://example.com/first"))
    await started
    const controller = new AbortController()
    const queued = run(
      f.browser.inspect(1, "https://example.com/stopped", controller.signal)
    )
    controller.abort()
    finish()
    await first
    await expect(queued).rejects.toThrow("stopped")
    expect(f.visits).toEqual(["https://example.com/first"])
  })
  it("retires a session acquired after its reply stops", async () => {
    const f = fixture()
    await run(f.browser.configure(policy))
    const controller = new AbortController()
    f.driver.open = async () => {
      controller.abort()
      return {
        id: "aborted-session",
        targetId: "synthetic",
        expiresAt: Date.now() + 60_000,
      }
    }
    await expect(
      run(f.browser.inspect(1, "https://example.com", controller.signal))
    ).rejects.toThrow("stopped")
    expect(f.visits).toEqual([])
    await run(f.browser.cleanup())
    expect(f.closed).toEqual(["aborted-session"])
  })
  it("keeps the tab locked until interrupted driver work settles", async () => {
    const f = fixture()
    await run(f.browser.configure(policy))
    let start!: () => void, finish!: () => void
    const started = new Promise<void>((resolve) => {
      start = resolve
    })
    f.driver.navigate = async (_session, url) => {
      f.visits.push(url)
      if (url.endsWith("/first")) {
        start()
        await new Promise<void>((resolve) => {
          finish = resolve
        })
      }
      return capture
    }
    const controller = new AbortController()
    const first = run(
      f.browser.inspect(1, "https://example.com/first", controller.signal),
      { signal: controller.signal }
    ).catch(() => undefined)
    await started
    controller.abort()
    const second = run(f.browser.inspect(1, "https://example.com/second"))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(f.visits).toEqual(["https://example.com/first"])
    finish()
    await Promise.all([first, second])
    expect(f.visits).toEqual([
      "https://example.com/first",
      "https://example.com/second",
    ])
    expect(f.browser.state().status).toBe("ready")
  })
  it("rejects screenshot requests for an older capture", async () => {
    const f = fixture()
    await run(f.browser.configure(policy))
    await run(f.browser.inspect(1, "https://example.com"))
    const version = f.browser.state().version
    const image = () =>
      run(
        browserRequest(
          f.browser,
          new Request(
            `https://app.example.com/browser/screenshot?version=${version}`
          ),
          "browser/screenshot"
        )
      )
    expect((await image()).status).toBe(200)
    await run(f.browser.inspect(1))
    expect((await image()).status).toBe(409)
    f.archive()
    await run(f.browser.close(1))
    expect(f.browser.state().status).toBe("closed")
  })
  it("redacts provider errors and validates public HTTP commands before dispatch", async () => {
    const f = fixture()
    await run(f.browser.configure(policy))
    f.driver.open = async () => {
      throw new Error("private provider error")
    }
    const response = await run(
      browserRequest(
        f.browser,
        new Request("https://app.example.com", {
          method: "POST",
          body: JSON.stringify({ generation: 1, url: "https://example.com" }),
        }),
        "browser/open"
      )
    )
    expect(response.status).toBe(409)
    expect(await response.text()).not.toContain("private provider error")
    expect(f.browser.state().status).toBe("error")
    const invalid = await run(
      browserRequest(
        f.browser,
        new Request("https://app.example.com", {
          method: "POST",
          body: JSON.stringify({ generation: -1, hosts: [] }),
        }),
        "browser/policy"
      )
    )
    expect(invalid.status).toBe(409)
  })
})
