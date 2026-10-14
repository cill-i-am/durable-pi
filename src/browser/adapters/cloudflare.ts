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
  type BrowserAction,
  type BrowserController,
} from "../contracts"

export class CloudflareBrowser implements BrowserDriver {
  constructor(private readonly binding: BrowserRun) {}
  async open(
    hosts: readonly string[],
    unrestricted = false
  ): Promise<BrowserSession> {
    const browser = await puppeteer
      .launch(this.binding, {
        keep_alive: BROWSER_IDLE_MS,
        ...(unrestricted
          ? {}
          : {
              guardrails: {
                allowedDomains: [...hosts],
                allowedDomainSets: ["common-cdns"],
              },
            }),
      })
      .catch((cause: unknown) => {
        throw sessionFailure(cause, "open")
      })
    try {
      const page = await browser.newPage()
      if (!unrestricted) {
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
      }
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
    const browser: Browser = await puppeteer
      .connect(this.binding, session.id)
      .catch((cause: unknown) => {
        throw sessionFailure(cause, "connect")
      })
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
        outcome: "rejected",
        message:
          "This browser tab has closed. Close the session and open a page again.",
      })
    } finally {
      clearTimeout(deadline)
      await browser.disconnect()
    }
  }
  private async restrictNavigation(
    page: Page,
    hosts: readonly string[],
    unrestricted: boolean
  ) {
    await page.setRequestInterception(true)
    page.on("request", (request) => {
      if (request.isInterceptResolutionHandled()) return
      if (
        request.isNavigationRequest() &&
        request.frame() === page.mainFrame()
      ) {
        try {
          allowedBrowserUrl(request.url(), hosts, unrestricted)
        } catch {
          void request.abort("blockedbyclient").catch(() => {})
          return
        }
      }
      void request.continue().catch(() => {})
    })
  }
  navigate(
    session: BrowserSession,
    url: string,
    hosts: readonly string[],
    unrestricted = false
  ) {
    return this.withPage(session, async (page) => {
      await this.restrictNavigation(page, hosts, unrestricted)
      const response = await page.goto(
        allowedBrowserUrl(url, hosts, unrestricted),
        {
          waitUntil: "domcontentloaded",
        }
      )
      if (page.url() === "chrome-error://chromewebdata/")
        throw new BrowserFailure({
          outcome: "failed",
          message:
            "Cloudflare Browser Run could not load the page. Chromium returned a network error page instead of site content.",
        })
      if (response?.headers()["cf-mitigated"] === "guardrails")
        throw new BrowserFailure({
          message:
            "The site requested a destination outside this bot's allowed sites. Update the allowed sites if it is needed.",
        })
      return this.snapshot(page, hosts, unrestricted)
    })
  }
  capture(
    session: BrowserSession,
    hosts: readonly string[],
    unrestricted = false
  ) {
    return this.withPage(session, (page) =>
      this.snapshot(page, hosts, unrestricted)
    )
  }
  interact(
    session: BrowserSession,
    action: BrowserAction,
    expectedUrl: string,
    hosts: readonly string[],
    actor: BrowserController,
    unrestricted = false
  ) {
    return this.withPage(session, async (page) => {
      if (allowedBrowserUrl(page.url(), hosts, unrestricted) !== expectedUrl)
        throw new BrowserFailure({
          outcome: "rejected",
          message: "The page navigated. Refresh its view before interacting.",
        })
      await this.restrictNavigation(page, hosts, unrestricted)
      if (
        actor === "owner" &&
        action.kind === "type" &&
        (await this.isolated(page, SUPPORTED_FOCUS)) !== true
      )
        throw new BrowserFailure({
          outcome: "rejected",
          message:
            "This field cannot be typed into safely here. Use a standard input on the site's own sign-in page; embedded frames and closed custom controls are not supported.",
        })
      if (actor === "agent" && action.kind === "type") {
        const sensitive = await this.isolated(page, SENSITIVE_FOCUS)
        if (sensitive !== false)
          throw new BrowserFailure({
            outcome: "rejected",
            message:
              "This field requires owner control. Ask the owner to use Take control; do not request credentials in chat.",
          })
      }
      const navigation =
        action.kind === "click" ||
        (action.kind === "key" && action.key === "Enter")
          ? page
              .waitForNavigation({
                waitUntil: "domcontentloaded",
                timeout: 2000,
              })
              .catch(() => null)
          : undefined
      if (action.kind === "click") await page.mouse.click(action.x, action.y)
      else if (action.kind === "type")
        await page.keyboard.sendCharacter(action.text)
      else if (action.kind === "scroll")
        await page.mouse.wheel({ deltaY: action.deltaY })
      else if (action.key === "SelectAll") {
        await page.keyboard.down("Control")
        try {
          await page.keyboard.press("A")
        } finally {
          await page.keyboard.up("Control")
        }
      } else await page.keyboard.press(action.key)
      await navigation
      return this.snapshot(page, hosts, unrestricted)
    })
  }
  private async isolated(page: Page, expression: string): Promise<unknown> {
    const cdp = await page.createCDPSession()
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
          expression,
          returnByValue: true,
          timeout: 15_000,
        },
        { timeout: 15_000 }
      )
      if (observation.exceptionDetails)
        throw new Error("Page observation failed")
      return observation.result.value
    } finally {
      await cdp.detach()
    }
  }
  private async snapshot(
    page: Page,
    hosts: readonly string[],
    unrestricted: boolean
  ): Promise<BrowserCapture> {
    const url = allowedBrowserUrl(page.url(), hosts, unrestricted)
    const raw = await this.isolated(page, PAGE_OBSERVATION)
    const contents = Schema.decodeUnknownSync(BrowserPage)({
      ...(typeof raw === "object" && raw !== null ? raw : {}),
      url,
      capturedAt: Date.now(),
    })
    let screenshot: string | null = null
    try {
      await this.isolated(page, MASK_FIELDS)
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
    } finally {
      await this.isolated(page, UNMASK_FIELDS)
    }
    if (allowedBrowserUrl(page.url(), hosts, unrestricted) !== url)
      throw new BrowserFailure({
        message: "The page navigated while being captured. Refresh the view.",
      })
    return { page: contents, screenshot }
  }
  async close(id: string) {
    if (await this.binding.getSession(id)) await this.binding.closeSession(id)
  }
}

function sessionFailure(cause: unknown, operation: "open" | "connect") {
  const status =
    cause instanceof Error
      ? /\bcode: (\d{3}): message:/.exec(cause.message)?.[1]
      : undefined
  return new BrowserFailure({
    outcome: "rejected",
    message:
      status === "429"
        ? "Cloudflare Browser Run has reached its browser or session limit. Wait before opening another session."
        : status === "401" || status === "403"
          ? "Cloudflare Browser Run denied session access. Check the browser binding and account permissions."
          : operation === "connect"
            ? "This browser session is no longer available or is busy. Close it and open a page again."
            : "Cloudflare Browser Run could not open a session. Try again later; if this persists, check the browser service.",
  })
}

export const SUPPORTED_FOCUS = `(() => {
  let element = document.activeElement;
  for (let n = 0; n < 10 && element?.shadowRoot?.activeElement; n++) element = element.shadowRoot.activeElement;
  return !!element && ['INPUT', 'TEXTAREA'].includes(element.tagName) && !element.disabled && !element.readOnly;
})()`
export const SENSITIVE_FOCUS = `(() => {
  let element = document.activeElement;
  for (let n = 0; n < 10 && element?.shadowRoot?.activeElement; n++) element = element.shadowRoot.activeElement;
  return !element || !['INPUT', 'TEXTAREA'].includes(element.tagName) || element.disabled || element.readOnly || (element.type || '').toLowerCase() === 'password' || /password|one-time-code/.test((element.autocomplete || '').toLowerCase());
})()`

export const MASK_FIELDS = `(() => {
  const masks = globalThis.__durablePiMasks = [];
  const roots = [document];
  let count = 0;
  for (let i = 0; i < roots.length; i++) {
    for (const element of roots[i].querySelectorAll('*')) {
      if (++count > 20000) throw new Error('Page too large to mask');
      if (element.shadowRoot) roots.push(element.shadowRoot);
      if (element.matches('input, textarea, [contenteditable], [contenteditable] *')) {
        const property = '-webkit-text-security';
        masks.push([element, property, element.style.getPropertyValue(property), element.style.getPropertyPriority(property)]);
        element.style.setProperty(property, 'disc', 'important');
      }
    }
  }
  return true;
})()`
export const UNMASK_FIELDS = `(() => {
  for (const [element, property, value, priority] of globalThis.__durablePiMasks || []) {
    if (value) element.style.setProperty(property, value, priority);
    else element.style.removeProperty(property);
  }
  delete globalThis.__durablePiMasks;
  return true;
})()`

export const PAGE_OBSERVATION = `(() => ({
      focus: (() => {
        let el = document.activeElement;
        for (let n = 0; n < 10 && el?.shadowRoot?.activeElement; n++) el = el.shadowRoot.activeElement;
        if (!el || el.tagName === 'BODY' || el.tagName === 'HTML') return null;
        return { label: (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.labels?.[0]?.innerText || el.tagName.toLowerCase()).slice(0, 120), kind: (el.type || el.tagName.toLowerCase()).slice(0, 40), secret: ${SENSITIVE_FOCUS} };
      })(),
      title: document.title.slice(0, 200),
      text: (() => {
        const body = document.querySelector('body');
        if (!body) return '';
        const walker = document.createTreeWalker(body, 4);
        let text = '', node, count = 0;
        while ((node = walker.nextNode()) && ++count <= 20000 && text.length < 24000) {
          const parent = node.parentElement;
          if (parent && !parent.closest('script, style, input, textarea, [contenteditable], [hidden], [aria-hidden="true"]') && parent.getClientRects().length) text += node.textContent.slice(0, 24000 - text.length) + '\\n';
        }
        return text.slice(0, 24000);
      })(),
      links: Array.from(document.querySelectorAll("a[href]"))
        .slice(0, 100)
        .filter((link) => !link.closest('[contenteditable]') && !link.querySelector('input, textarea, [contenteditable]'))
        .map((link) => ({
          text: (
            link.innerText ||
            link.getAttribute("aria-label") ||
            link.href
          ).slice(0, 120),
          url: link.href.slice(0, 2048),
        }))
        .filter((link) => /^https?:/.test(link.url))
        .slice(0, 20),
    }))()`
