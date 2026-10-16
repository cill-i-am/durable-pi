import { Buffer as NativeBuffer } from "node:buffer"

import puppeteer, {
  TimeoutError,
  InterceptResolutionAction,
  type Browser,
  type Page,
  type HTTPRequest,
} from "@cloudflare/puppeteer"
import { Clock, Effect, Exit, Schema } from "effect"
import type { Scope } from "effect"

import { orDieAll } from "../../shared/effect"
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
import { BrowserSessionRecord } from "../domain"
import { BrowserUnavailable, type BrowserDriver } from "../driver"
import {
  browserNativeFailure,
  nativeBrowserOperation as native,
} from "./interop"

// Workers declares the Node export as any; use Node's published constructor contract.
const Buffer = NativeBuffer as BufferConstructor

export class CloudflareBrowser implements BrowserDriver {
  constructor(private readonly binding: BrowserRun) {}
  private destination(
    url: string,
    hosts: readonly string[],
    unrestricted: boolean
  ) {
    return Effect.try({
      try: () => allowedBrowserUrl(url, hosts, unrestricted),
      catch: (cause) => {
        const browserFailure = Schema.decodeUnknownOption(BrowserFailure)(cause)
        if (browserFailure._tag === "Some") return browserFailure.value
        throw cause
      },
    })
  }
  open(hosts: readonly string[], unrestricted = false) {
    return Effect.scoped(
      Effect.gen({ self: this }, function* () {
        const browser = yield* Effect.acquireRelease(
          native(
            () =>
              puppeteer.launch(this.binding, {
                keep_alive: BROWSER_IDLE_MS,
                ...(unrestricted
                  ? {}
                  : {
                      guardrails: {
                        allowedDomains: [...hosts],
                        allowedDomainSets: ["common-cdns"],
                      },
                    }),
              }),
            (cause) => sessionFailure(cause, "open")
          ),
          (value, exit) => {
            const disconnect = Effect.promise(async () => {
              await value.disconnect()
            })
            // A session is handed to the application only after transport cleanup succeeds.
            return Exit.isFailure(exit)
              ? Effect.promise(async () => {
                  await value.close()
                }).pipe(Effect.ensuring(disconnect))
              : disconnect.pipe(
                  Effect.onError(() =>
                    Effect.promise(async () => {
                      await value.close()
                    })
                  )
                )
          }
        )
        const page = yield* native(() => browser.newPage())
        if (!unrestricted) {
          const blocked = yield* native(() =>
            page.goto("https://durable-pi-policy-probe.invalid", {
              waitUntil: "domcontentloaded",
              timeout: 10000,
            })
          )
          if (
            blocked?.status() !== 403 ||
            blocked.headers()["cf-mitigated"] !== "guardrails" ||
            blocked.headers()["cf-brapi-guardrails-reason"] !==
              "not-in-allowlist"
          )
            return yield* new BrowserFailure({
              message:
                "The browser service did not confirm destination restrictions. No browsing session was opened.",
            })
        }
        yield* native(() => page.goto("about:blank"))
        yield* native(() =>
          page.setViewport({ width: 1024, height: 768, deviceScaleFactor: 1 })
        )
        const targetId = yield* this.targetId(page)
        return Schema.decodeUnknownSync(BrowserSessionRecord)({
          id: browser.sessionId(),
          targetId,
          expiresAt: (yield* Clock.currentTimeMillis) + BROWSER_SESSION_MS,
        })
      })
    )
  }
  private withCdp<T>(
    page: Page,
    use: (
      cdp: Awaited<ReturnType<Page["createCDPSession"]>>
    ) => Effect.Effect<T, BrowserFailure | BrowserUnavailable>
  ) {
    return Effect.acquireUseRelease(
      native(() => page.createCDPSession()),
      use,
      (cdp) =>
        Effect.promise(async () => {
          await cdp.detach()
        })
    )
  }
  private targetId(page: Page) {
    return this.withCdp(page, (cdp) =>
      native(() => cdp.send("Target.getTargetInfo")).pipe(
        Effect.map(({ targetInfo }) => targetInfo.targetId)
      )
    )
  }
  private withPage<T>(
    session: BrowserSession,
    use: (
      page: Page
    ) => Effect.Effect<T, BrowserFailure | BrowserUnavailable, Scope.Scope>
  ) {
    return Effect.scoped(
      Effect.gen({ self: this }, function* () {
        let closing: Promise<void> | undefined
        const browser: Browser = yield* Effect.acquireRelease(
          native(
            () => puppeteer.connect(this.binding, session.id),
            (cause) => sessionFailure(cause, "connect")
          ),
          (value) => Effect.promise(() => disconnect(value))
        )
        function disconnect(value: Browser) {
          return (closing ??= Promise.resolve().then(() => value.disconnect()))
        }
        // The timer belongs to this call. Scope closure joins a disconnect already in flight.
        yield* Effect.sleep("30 seconds").pipe(
          Effect.andThen(
            Effect.promise(() => disconnect(browser)).pipe(
              Effect.exit,
              Effect.uninterruptible
            )
          ),
          Effect.forkScoped
        )
        const pages = yield* native(() => browser.pages())
        for (const page of pages.slice(0, 10)) {
          if ((yield* this.targetId(page)) === session.targetId) {
            page.setDefaultTimeout(15000)
            page.setDefaultNavigationTimeout(15000)
            return yield* use(page)
          }
        }
        return yield* new BrowserFailure({
          outcome: "rejected",
          message:
            "This browser tab has closed. Close the session and open a page again.",
        })
      })
    )
  }
  private restrictNavigation(
    page: Page,
    hosts: readonly string[],
    unrestricted: boolean
  ) {
    return Effect.gen(function* () {
      const pending = new Set<Promise<void>>()
      let failure: { cause: unknown } | undefined
      const handler = (request: HTTPRequest) => {
        const work = Promise.resolve().then(async () => {
          if (
            request.isInterceptResolutionHandled() ||
            request.interceptResolutionState().action ===
              InterceptResolutionAction.Disabled
          )
            return
          if (
            request.isNavigationRequest() &&
            request.frame() === page.mainFrame()
          ) {
            try {
              allowedBrowserUrl(request.url(), hosts, unrestricted)
            } catch {
              await request.abort("blockedbyclient")
              return
            }
          }
          await request.continue()
        })
        pending.add(work)
        void work.then(
          () => pending.delete(work),
          (cause: unknown) => {
            pending.delete(work)
            failure ??= { cause }
          }
        )
      }
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          page.on("request", handler)
        }),
        () =>
          Effect.sync(() => {
            page.off("request", handler)
          }).pipe(
            Effect.ensuring(
              Effect.promise(async () => {
                await Promise.allSettled([...pending])
                if (failure) throw failure.cause
              })
            )
          )
      )
      yield* native(() => page.setRequestInterception(true))
    })
  }
  navigate(
    session: BrowserSession,
    url: string,
    hosts: readonly string[],
    unrestricted = false
  ) {
    return this.withPage(session, (page) =>
      Effect.gen({ self: this }, function* () {
        yield* this.restrictNavigation(page, hosts, unrestricted)
        const destination = yield* this.destination(url, hosts, unrestricted)
        const result = yield* native(() =>
          page
            .goto(destination, {
              waitUntil: "domcontentloaded",
            })
            .then(
              (response) => ({ ok: true as const, response }),
              (cause: unknown) => ({ ok: false as const, cause })
            )
        )
        if (!result.ok) {
          if (result.cause instanceof TimeoutError) {
            yield* this.withCdp(page, (cdp) =>
              native(() =>
                cdp.send("Page.stopLoading", undefined, { timeout: 5000 })
              )
            )
            return yield* new BrowserFailure({
              outcome: "failed",
              message:
                "The page did not finish loading within 15 seconds. Loading was stopped. Inspect the current page before trying again or use another source.",
            })
          }
          const code =
            result.cause instanceof Error
              ? /^net::(ERR_[A-Z_]+)(?: at |$)/.exec(result.cause.message)?.[1]
              : undefined
          if (code)
            return yield* new BrowserFailure({
              outcome: "failed",
              message: `Cloudflare Browser Run could not load the page (${code}). Check the address or use another source.`,
            })
          return yield* browserNativeFailure(result.cause)
        }
        const response = result.response
        if (page.url() === "chrome-error://chromewebdata/")
          return yield* new BrowserFailure({
            outcome: "failed",
            message:
              "Cloudflare Browser Run could not load the page. Chromium returned a network error page instead of site content.",
          })
        if (response?.headers()["cf-mitigated"] === "guardrails")
          return yield* new BrowserFailure({
            message:
              "The site requested a destination outside this bot's allowed sites. Update the allowed sites if it is needed.",
          })
        return yield* this.snapshot(page, hosts, unrestricted)
      })
    )
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
    return this.withPage(session, (page) =>
      Effect.gen({ self: this }, function* () {
        if (
          (yield* this.destination(page.url(), hosts, unrestricted)) !==
          expectedUrl
        )
          return yield* new BrowserFailure({
            outcome: "rejected",
            message: "The page navigated. Refresh its view before interacting.",
          })
        yield* this.restrictNavigation(page, hosts, unrestricted)
        if (
          actor === "owner" &&
          action.kind === "type" &&
          (yield* this.isolated(page, SUPPORTED_FOCUS)) !== true
        )
          return yield* new BrowserFailure({
            outcome: "rejected",
            message:
              "This field cannot be typed into safely here. Use a standard input on the site's own sign-in page; embedded frames and closed custom controls are not supported.",
          })
        if (
          actor === "agent" &&
          action.kind === "type" &&
          (yield* this.isolated(page, SENSITIVE_FOCUS)) !== false
        )
          return yield* new BrowserFailure({
            outcome: "rejected",
            message:
              "This field requires owner control. Ask the owner to use Take control; do not request credentials in chat.",
          })
        const watching =
          action.kind === "click" ||
          (action.kind === "key" && action.key === "Enter")
            ? yield* Effect.acquireRelease(
                Effect.sync(() => ({
                  completed: page
                    .waitForNavigation({
                      waitUntil: "domcontentloaded",
                      timeout: 2000,
                    })
                    .then(
                      () => ({ ok: true as const }),
                      (cause: unknown) => ({ ok: false as const, cause })
                    ),
                })),
                (work) =>
                  Effect.promise(async () => {
                    await work.completed
                  })
              )
            : undefined
        if (action.kind === "click")
          yield* native(() => page.mouse.click(action.x, action.y))
        else if (action.kind === "type")
          yield* native(() => page.keyboard.sendCharacter(action.text))
        else if (action.kind === "scroll")
          yield* native(() => page.mouse.wheel({ deltaY: action.deltaY }))
        else if (action.key === "SelectAll")
          yield* native(() => page.keyboard.down("Control")).pipe(
            Effect.andThen(native(() => page.keyboard.press("A"))),
            Effect.ensuring(
              Effect.promise(async () => {
                await page.keyboard.up("Control")
              })
            )
          )
        else {
          const key = action.key
          yield* native(() => page.keyboard.press(key))
        }
        if (watching) {
          const result = yield* Effect.promise(() => watching.completed)
          if (!result.ok && !(result.cause instanceof TimeoutError))
            return yield* browserNativeFailure(result.cause)
        }
        return yield* this.snapshot(page, hosts, unrestricted)
      })
    )
  }
  private isolated(
    page: Page,
    expression: string
  ): Effect.Effect<unknown, BrowserFailure | BrowserUnavailable> {
    return this.withCdp(page, (cdp) =>
      Effect.gen(function* () {
        const { frameTree } = yield* native(() =>
          cdp.send("Page.getFrameTree", undefined, { timeout: 15000 })
        )
        const { executionContextId } = yield* native(() =>
          cdp.send(
            "Page.createIsolatedWorld",
            {
              frameId: frameTree.frame.id,
              worldName: "durable-pi-observation",
              grantUniveralAccess: false,
            },
            { timeout: 15000 }
          )
        )
        const observation = yield* native(() =>
          cdp.send(
            "Runtime.evaluate",
            {
              contextId: executionContextId,
              expression,
              returnByValue: true,
              timeout: 15000,
            },
            { timeout: 15000 }
          )
        )
        if (observation.exceptionDetails) return yield* new BrowserUnavailable()
        return observation.result.value as unknown
      })
    )
  }
  private snapshot(
    page: Page,
    hosts: readonly string[],
    unrestricted: boolean
  ): Effect.Effect<BrowserCapture, BrowserFailure | BrowserUnavailable> {
    return Effect.gen({ self: this }, function* () {
      const url = yield* this.destination(page.url(), hosts, unrestricted)
      const raw = yield* this.isolated(page, PAGE_OBSERVATION),
        capturedAt = yield* Clock.currentTimeMillis
      const contents = Schema.decodeUnknownSync(BrowserPage)({
        ...(typeof raw === "object" && raw !== null ? raw : {}),
        url,
        capturedAt,
      })
      let screenshot: string | null = null
      yield* Effect.gen({ self: this }, function* () {
        yield* this.isolated(page, MASK_FIELDS)
        for (const quality of [45, 20]) {
          const image = yield* native(() =>
            page.screenshot({ type: "jpeg", quality, fullPage: false })
          )
          if (image.byteLength <= 96 * 1024) {
            screenshot = Buffer.from(image).toString("base64")
            break
          }
        }
      }).pipe(
        Effect.ensuring(this.isolated(page, UNMASK_FIELDS).pipe(orDieAll))
      )
      if ((yield* this.destination(page.url(), hosts, unrestricted)) !== url)
        return yield* new BrowserFailure({
          message: "The page navigated while being captured. Refresh the view.",
        })
      return { page: contents, screenshot }
    })
  }
  close(id: string) {
    return Effect.gen({ self: this }, function* () {
      if (yield* native(() => this.binding.getSession(id)))
        yield* native(() => this.binding.closeSession(id))
    })
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
