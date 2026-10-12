import { describe, expect, it, vi } from "vitest"
import { Effect, Schema } from "effect"
import { BrowserWorkspace, type BrowserDriver } from "../src/browser/browser"
import { BrowserStore } from "../src/browser/adapters/sqlite"
import {
  BrowserPolicy,
  BrowserInteraction,
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
    interact: async () => capture,
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
    await run(
      b.browser.configure({ generation: 0, hosts: [], unrestricted: false })
    )
    await expect(
      run(b.browser.inspect(1, "https://example.com"))
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
  it("hands control to the owner, fences bot work, and keeps input out of the persisted record", async () => {
    const f = fixture()
    await run(f.browser.configure(policy))
    await run(f.browser.inspect(1, "https://example.com"))
    f.driver.capture = async () => ({
      ...capture,
      page: { ...capture.page, capturedAt: Date.now() },
    })
    await run(f.browser.control(1, "owner"))
    const sessionId = f.repository.read().session!.id
    expect(f.browser.state().controller).toBe("owner")
    await expect(run(f.browser.inspect(2))).rejects.toThrow(
      "owner has browser control"
    )
    let inputs = 0
    f.driver.interact = async (_session, action) => {
      inputs++
      expect(action.kind).toBe("type")
      return { ...capture, page: { ...capture.page, capturedAt: Date.now() } }
    }
    const input = {
      generation: 2,
      version: f.browser.state().version,
      action: { kind: "type" as const, text: "synthetic-sensitive-input" },
    }
    await run(f.browser.interact(input, "owner"))
    await expect(run(f.browser.interact(input, "owner"))).rejects.toThrow(
      "view changed"
    )
    expect(inputs).toBe(1)
    expect(JSON.stringify(f.repository.read())).not.toContain(input.action.text)
    await run(f.browser.control(2, "agent"))
    expect(f.repository.read().session!.id).toBe(sessionId)
    expect(f.browser.state().controller).toBe("agent")
    await expect(
      run(
        f.browser.interact(
          { ...input, generation: 3, version: f.browser.state().version },
          "owner"
        )
      )
    ).rejects.toThrow("Take control")
    await run(f.browser.inspect(3))
  })
  it("takes a fresh capture after in-flight agent work settles on takeover", async () => {
    const f = fixture()
    await run(f.browser.configure(policy))
    await run(f.browser.inspect(1, "https://example.com"))
    let start!: () => void, finish!: () => void
    const started = new Promise<void>((resolve) => {
      start = resolve
    })
    f.driver.navigate = async () => {
      start()
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return capture
    }
    f.driver.capture = async () => ({
      ...capture,
      page: { ...capture.page, title: "After takeover" },
    })
    const navigation = run(
      f.browser.inspect(1, "https://example.com/next")
    ).catch(() => undefined)
    await started
    const takeover = run(f.browser.control(1, "owner"))
    await Promise.resolve()
    expect(f.browser.state().controller).toBe("owner")
    expect(f.browser.state().page).toBeNull()
    finish()
    await Promise.all([navigation, takeover])
    expect(f.browser.state().page?.title).toBe("After takeover")
  })
  it("never repeats an interrupted or uncertain interaction", async () => {
    const f = fixture()
    await run(f.browser.configure(policy))
    f.driver.navigate = async () => ({
      ...capture,
      page: { ...capture.page, capturedAt: Date.now() },
    })
    await run(f.browser.inspect(1, "https://example.com"))
    let calls = 0
    f.driver.interact = async () => {
      calls++
      throw new Error("Unknown provider outcome")
    }
    const input = {
      generation: 1,
      version: f.browser.state().version,
      action: { kind: "click" as const, x: 1, y: 1 },
    }
    await expect(run(f.browser.interact(input, "agent"))).rejects.toThrow(
      "may have run"
    )
    const restored = new BrowserWorkspace(
      new BrowserStore(f.db),
      f.driver,
      () => true,
      async () => {}
    )
    restored.recover()
    expect(restored.state().hasScreenshot).toBe(false)
    await expect(
      run(
        restored.interact(
          { ...input, version: restored.state().version },
          "agent"
        )
      )
    ).rejects.toThrow("view changed")
    await expect(run(restored.interact(input, "agent"))).rejects.toThrow(
      "view changed"
    )
    expect(calls).toBe(1)
    for (const action of [
      { kind: "click", x: 1024, y: 1 },
      { kind: "type", text: "x".repeat(2001) },
      { kind: "key", key: "F12" },
      { kind: "evaluate", code: "alert(1)" },
    ])
      expect(() =>
        Schema.decodeUnknownSync(BrowserInteraction)({ ...input, action })
      ).toThrow()
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

describe("unrestricted browser internet settings", () => {
  it("migrates saved policies as restricted and isolates bots", () => {
    const f = fixture()
    f.db.run(
      "INSERT INTO bot_browser VALUES (1,?)",
      JSON.stringify({ ...f.repository.read(), unrestricted: undefined })
    )
    expect(new BrowserStore(f.db).read().unrestricted).toBe(false)
    f.repository.reset(0, [], true)
    expect(new BrowserStore(f.db).read().unrestricted).toBe(true)
    expect(fixture().browser.state().policy.unrestricted).toBe(true)
  })
  it("allows public HTTP(S) destinations without widening URL scheme or credential access", () => {
    expect(allowedBrowserUrl("http://example.org:8080/path", [], true)).toBe(
      "http://example.org:8080/path"
    )
    expect(allowedBrowserUrl("https://example.org", [], true)).toBe(
      "https://example.org/"
    )
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://user:pass@example.org",
      "http://localhost",
      "http://127.0.0.1",
      "https://metadata.internal",
    ]) {
      expect(() => allowedBrowserUrl(url, [], true)).toThrow()
    }
    expect(() => allowedBrowserUrl("https://example.org", [])).toThrow()
  })
  it("opens without a site list, preserves the choice on close, and revokes on restriction", async () => {
    const f = fixture()
    f.driver.open = vi.fn(f.driver.open)
    await run(
      f.browser.configure({
        generation: 0,
        hosts: ["example.com"],
        unrestricted: true,
      })
    )
    await run(f.browser.inspect(1, "https://example.org"))
    expect(f.driver.open).toHaveBeenCalledWith(["example.com"], true)
    const session = f.repository.read().session!
    await run(f.browser.close(1))
    expect(f.browser.state().policy.unrestricted).toBe(true)
    await run(
      f.browser.configure({
        generation: 2,
        hosts: ["example.com"],
        unrestricted: false,
      })
    )
    await run(f.browser.cleanup())
    expect(f.closed).toContain(session.id)
    await expect(
      run(f.browser.inspect(3, "https://example.org"))
    ).rejects.toThrow("allowed sites")
    await expect(
      run(f.browser.configure({ generation: 2, hosts: [], unrestricted: true }))
    ).rejects.toThrow("changed")
    expect(f.browser.state().policy.unrestricted).toBe(false)
  })
  it("discards in-flight unrestricted output after policy revocation", async () => {
    const f = fixture()
    let finish!: (value: BrowserCapture) => void
    let started!: () => void
    const admitted = new Promise<void>((resolve) => {
      started = resolve
    })
    f.driver.navigate = async () => {
      started()
      return new Promise((resolve) => {
        finish = resolve
      })
    }
    await run(
      f.browser.configure({ generation: 0, hosts: [], unrestricted: true })
    )
    const pending = run(f.browser.inspect(1, "https://example.org"))
    await admitted
    await run(
      f.browser.configure({ generation: 1, hosts: [], unrestricted: false })
    )
    finish(capture)
    await expect(pending).rejects.toThrow("changed")
    expect(f.browser.state()).toMatchObject({
      policy: { unrestricted: false },
      page: null,
      status: "closed",
    })
  })
})
