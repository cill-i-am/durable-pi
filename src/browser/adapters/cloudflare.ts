import puppeteer, { type Browser, type Page } from "@cloudflare/puppeteer"
import { Schema } from "effect"
import type { BrowserDriver } from "../browser"
import {
  BROWSER_IDLE_MS,
  BROWSER_SESSION_MS,
  BrowserFailure,
  BrowserPage,
  allowedBrowserUrl,
  type BrowserSession,
  type BrowserCapture,
} from "../contracts"

/** Browser Run owns Chromium, session networking, and idle expiry. Never exports a CDP capability. */
export class CloudflareBrowser implements BrowserDriver {
  constructor(private readonly binding: BrowserRun) {}
  async open(hosts: readonly string[]): Promise<BrowserSession> {
    const browser = await puppeteer.launch(this.binding, {
      keep_alive: BROWSER_IDLE_MS,
      guardrails: {
        allowedDomains: [...hosts],
        allowedDomainSets: ["common-cdns"],
      },
    })
    try {
      const page = await browser.newPage()
      // Fail closed when a runtime accepts, but does not enforce, guardrails.
      const blocked = await page.goto(
        "https://durable-pi-policy-probe.invalid",
        { waitUntil: "domcontentloaded", timeout: 10_000 }
      )
      if (
        blocked?.status() !== 403 ||
        blocked.headers()["cf-mitigated"] !== "guardrails" ||
        blocked.headers()["cf-brapi-guardrails-reason"] !== "not-in-allowlist"
      )
        throw new BrowserFailure({
          message:
            "The browser service did not confirm destination restrictions. No browsing session was opened.",
        })
      await page.goto("about:blank")
      await page.setViewport({ width: 1024, height: 768, deviceScaleFactor: 1 })
      const cdp = await page.createCDPSession()
      const { targetInfo } = await cdp.send("Target.getTargetInfo")
      await cdp.detach()
      return {
        id: browser.sessionId(),
        targetId: targetInfo.targetId,
        expiresAt: Date.now() + BROWSER_SESSION_MS,
      }
    } catch (cause) {
      await browser.close().catch(() => {})
      throw cause
    } finally {
      await browser.disconnect()
    }
  }
  private async withPage<T>(
    session: BrowserSession,
    run: (page: Page) => Promise<T>
  ) {
    const browser: Browser = await puppeteer.connect(this.binding, session.id)
    // Bound a hung CDP operation; disconnect rejects outstanding commands before releasing the tab.
    const deadline = setTimeout(() => {
      void browser.disconnect().catch(() => {})
    }, 30_000)
    try {
      const pages = await browser.pages()
      for (const page of pages.slice(0, 10)) {
        const cdp = await page.createCDPSession()
        const { targetInfo } = await cdp.send("Target.getTargetInfo")
        await cdp.detach()
        if (targetInfo.targetId === session.targetId) {
          page.setDefaultTimeout(15_000)
          page.setDefaultNavigationTimeout(15_000)
          return await run(page)
        }
      }
      throw new BrowserFailure({
        message:
          "This browser tab has closed. Close the session and open a page again.",
      })
    } finally {
      clearTimeout(deadline)
      await browser.disconnect()
    }
  }
  navigate(session: BrowserSession, url: string, hosts: readonly string[]) {
    return this.withPage(session, async (page) => {
      await page.setRequestInterception(true)
      page.on("request", (request) => {
        if (request.isInterceptResolutionHandled()) return
        if (
          request.isNavigationRequest() &&
          request.frame() === page.mainFrame()
        ) {
          try {
            allowedBrowserUrl(request.url(), hosts)
          } catch {
            void request.abort("blockedbyclient").catch(() => {})
            return
          }
        }
        void request.continue().catch(() => {})
      })
      const response = await page.goto(allowedBrowserUrl(url, hosts), {
        waitUntil: "domcontentloaded",
      })
      if (response?.headers()["cf-mitigated"] === "guardrails")
        throw new BrowserFailure({
          message:
            "The site requested a destination outside this bot's allowed sites. Update the allowed sites if it is needed.",
        })
      return this.snapshot(page, hosts)
    })
  }
  capture(session: BrowserSession, hosts: readonly string[]) {
    return this.withPage(session, (page) => this.snapshot(page, hosts))
  }
  private async snapshot(
    page: Page,
    hosts: readonly string[]
  ): Promise<BrowserCapture> {
    const url = allowedBrowserUrl(page.url(), hosts)
    const cdp = await page.createCDPSession()
    let contents: BrowserPage
    try {
      const { frameTree } = await cdp.send("Page.getFrameTree", undefined, {
        timeout: 15_000,
      })
      const { executionContextId } = await cdp.send(
        "Page.createIsolatedWorld",
        {
          frameId: frameTree.frame.id,
          worldName: "durable-pi-observation",
          grantUniveralAccess: false,
        },
        { timeout: 15_000 }
      )
      const observation = await cdp.send(
        "Runtime.evaluate",
        {
          contextId: executionContextId,
          expression: PAGE_OBSERVATION,
          returnByValue: true,
          timeout: 15_000,
        },
        { timeout: 15_000 }
      )
      if (observation.exceptionDetails)
        throw new Error("Page observation failed")
      contents = Schema.decodeUnknownSync(BrowserPage)({
        ...observation.result.value,
        url,
        capturedAt: Date.now(),
      })
    } finally {
      await cdp.detach()
    }
    // Page observations are untrusted data. No HTML, script, or cookie values reach the UI.
    let screenshot: string | null = null
    for (const quality of [45, 20]) {
      const image = await page.screenshot({
        type: "jpeg",
        quality,
        fullPage: false,
      })
      if (image.byteLength <= 96 * 1024) {
        screenshot = Buffer.from(image).toString("base64")
        break
      }
    }
    if (allowedBrowserUrl(page.url(), hosts) !== url)
      throw new BrowserFailure({
        message: "The page navigated while being captured. Refresh the view.",
      })
    return { page: contents, screenshot }
  }
  async close(id: string) {
    // Closing an already-expired session is complete; errors still retry through the cleanup job.
    if (await this.binding.getSession(id)) await this.binding.closeSession(id)
  }
}

// Trusted built-in observer, evaluated only in an isolated world. Never accepts page or model code.
export const PAGE_OBSERVATION = `(() => ({
      title: document.title.slice(0, 200),
      text: (document.querySelector("body")?.innerText ?? "").slice(0, 24_000),
      links: Array.from(document.querySelectorAll("a[href]"))
        .slice(0, 100)
        .map((link) => ({
          text: (
            link.innerText ||
            link.getAttribute("aria-label") ||
            link.href
          ).slice(0, 120),
          url: link.href.slice(0, 2048),
        }))
        .filter((link) => link.url.startsWith("https://"))
        .slice(0, 20),
    }))()`
