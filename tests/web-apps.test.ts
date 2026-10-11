import { describe, expect, it } from "vitest"
import { Effect, Schema } from "effect"
import {
  AppDefinition,
  type InteractApp,
  type WebResult,
} from "../src/apps/contracts"
import { AppStore } from "../src/apps/adapters/sqlite"
import { WebApps, type WebExecutor } from "../src/apps/web"
import { appHtml } from "../src/apps/html"
import { webFrame } from "../src/features/apps/web-frame"
import { database } from "./database"

const definition: AppDefinition = {
  title: "Counter",
  description: "Private counter",
  blocks: [
    {
      id: "counter",
      type: "web",
      initialState: '{"count":0}',
      code: "return {}",
    },
  ],
}
const output = (state = '{"count":1}'): WebResult => ({
  html: '<button type="button" data-action="add">Add one</button>',
  css: "button{padding:12px}",
  state,
  summary: "Added one.",
})
function setup(
  execute: WebExecutor = async () => ({
    result: JSON.stringify(output()),
    logs: "",
    error: null,
  })
) {
  const db = database()
  let active = true
  const store = new AppStore(db, () => active),
    id = crypto.randomUUID()
  const draft = store.save({
    id,
    operationId: crypto.randomUUID(),
    expectedRevision: 0,
    definition,
  })
  const app = store.publish({
    id,
    operationId: crypto.randomUUID(),
    expectedRevision: draft.revision,
    version: 1,
  })
  const web = new WebApps(store, execute)
  const input: InteractApp = {
    id,
    version: 1,
    expectedRevision: app.revision,
    operationId: crypto.randomUUID(),
    action: { type: "web", blockId: "counter", name: "add", values: {} },
  }
  return {
    store,
    web,
    app,
    input,
    archiveBot: () => {
      active = false
      web.invalidate()
    },
    restoreBot: () => {
      active = true
    },
  }
}
const signal = () => new AbortController().signal
function controlled() {
  let finish!: (value: Awaited<ReturnType<WebExecutor>>) => void,
    enter!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const f = setup(async () => {
    enter()
    return new Promise((resolve) => {
      finish = resolve
    })
  })
  return {
    ...f,
    entered,
    finish: () =>
      finish({ result: JSON.stringify(output()), logs: "", error: null }),
  }
}

describe("generated HTML boundary", () => {
  it("keeps semantic controls while excluding executable, foreign, URL and navigation surfaces", () => {
    const safe = appHtml(
      '<form data-action="save" action="https://example.com" target="_top"><label for="note">Note</label><input id="note" name="note" type="text" onfocus="alert(1)"><button formaction="javascript:alert(2)" onclick="alert(3)">Save</button></form><script nonce="known">alert(4)</script><iframe srcdoc="x"></iframe><img src="https://example.com"><meta http-equiv="refresh" content="0;https://example.com"><a href="https://example.com">Leave</a><svg><foreignObject><form>bad</form></foreignObject></svg><math><mtext>bad</mtext></math>'
    )
    expect(safe).toBe(
      '<form data-action="save"><label for="note">Note</label><input id="note" name="note" type="text"><button>Save</button></form>'
    )
  })
  it("reparses encoded text without creating attributes and bounds node complexity", () => {
    expect(
      appHtml('<p title="&quot;&gt;&lt;script&gt;">&lt;script&gt;&amp;</p>')
    ).toBe('<p title="&quot;&gt;&lt;script&gt;">&lt;script&gt;&amp;</p>')
    expect(() =>
      appHtml("<div>".repeat(42) + "text" + "</div>".repeat(42))
    ).toThrow("too complex")
    expect(() => appHtml("<br>".repeat(1001))).toThrow("too complex")
    expect(() => appHtml('"'.repeat(11000))).toThrow("too large")
  })
  it("places only the trusted bridge behind a nonce and prevents CSS breaking its style element", () => {
    const html = webFrame(
      appHtml("<script>malicious()</script><p>Safe</p>"),
      "body{} </style><script>malicious()</script>",
      "test-channel",
      "11111111-1111-4111-8111-111111111111"
    )
    expect(html.match(/<script /g)).toHaveLength(1)
    expect(html).not.toContain("<script>malicious()")
    expect(html).toContain("default-src 'none'")
    expect(html).toContain(
      "script-src 'nonce-11111111-1111-4111-8111-111111111111'"
    )
    expect(html).toContain("event.isTrusted")
  })
})
describe("Cloudflare generated apps", () => {
  it("fences archive and restore between execution completion and commit", async () => {
    const f = controlled()
    const running = Effect.runPromise(f.web.interact(f.input, signal()))
    await f.entered
    f.finish()
    queueMicrotask(() =>
      queueMicrotask(() => {
        f.archiveBot()
        f.restoreBot()
      })
    )
    await expect(running).rejects.toThrow()
    expect(f.store.get(f.app.id)?.revision).toBe(f.app.revision)
    expect(f.store.pending()).toEqual([])
  })
  it("requires a sole web block and valid bounded initial JSON", () => {
    expect(Schema.is(AppDefinition)(definition)).toBe(true)
    expect(
      Schema.is(AppDefinition)({
        ...definition,
        blocks: [
          ...definition.blocks,
          { id: "extra", type: "text", text: "x" },
        ],
      })
    ).toBe(false)
    expect(
      Schema.is(AppDefinition)({
        ...definition,
        blocks: [{ ...definition.blocks[0], initialState: "invalid" }],
      })
    ).toBe(false)
  })
  it("renders privately without committing returned state and commits owner actions exactly once", async () => {
    let calls = 0
    const f = setup(async (input) => {
      calls++
      expect(input.data).toContain('"state":{"count":0}')
      return { result: JSON.stringify(output()), logs: "", error: null }
    })
    const preview = await Effect.runPromise(
      f.web.render({ id: f.app.id, version: 1 }, signal())
    )
    expect(preview.html).toContain('data-action="add"')
    expect(f.store.get(f.app.id)?.state.web).toBeUndefined()
    const applied = await Effect.runPromise(f.web.interact(f.input, signal()))
    expect(applied.state.web).toEqual({ counter: '{"count":1}' })
    expect(f.store.pending()).toHaveLength(1)
    expect(await Effect.runPromise(f.web.interact(f.input, signal()))).toEqual(
      applied
    )
    expect(calls).toBe(2)
    await expect(
      Effect.runPromise(
        f.web.interact(
          {
            ...f.input,
            action: {
              ...f.input.action,
              name: "different",
            } as InteractApp["action"],
          },
          signal()
        )
      )
    ).rejects.toMatchObject({ cause: { _tag: "AppConflict" } })
    expect(calls).toBe(2)
  })
  it.each([
    "cancel",
    "archive-app",
    "archive-bot",
    "restore-bot",
    "publish",
    "abort",
  ])("fences a late result after %s", async (mode) => {
    const f = controlled(),
      controller = new AbortController()
    const running = Effect.runPromise(
      f.web.interact(f.input, controller.signal)
    )
    await f.entered
    if (mode === "cancel") f.store.cancelOperation(f.input.operationId)
    if (mode === "archive-app")
      f.store.archive({
        id: f.app.id,
        operationId: crypto.randomUUID(),
        expectedRevision: f.app.revision,
        archived: true,
      })
    if (mode === "archive-bot") f.archiveBot()
    if (mode === "restore-bot") {
      f.archiveBot()
      f.restoreBot()
    }
    if (mode === "publish")
      f.store.publish({
        id: f.app.id,
        operationId: crypto.randomUUID(),
        expectedRevision: f.app.revision,
        version: 1,
      })
    if (mode === "abort") controller.abort()
    f.finish()
    await expect(running).rejects.toThrow()
    expect(f.store.get(f.app.id)?.state.web).toBeUndefined()
    expect(f.store.pending()).toEqual([])
  })
  it("rejects cancellation before dispatch and overlapping bot computation", async () => {
    const f = controlled()
    f.store.cancelOperation(f.input.operationId)
    await expect(
      Effect.runPromise(f.web.interact(f.input, signal()))
    ).rejects.toMatchObject({ cause: { _tag: "AppConflict" } })
    const preview = Effect.runPromise(
      f.web.render({ id: f.app.id, version: 1 }, signal())
    )
    await f.entered
    await expect(
      Effect.runPromise(f.web.render({ id: f.app.id, version: 1 }, signal()))
    ).rejects.toThrow("another app")
    f.finish()
    await preview
  })
  it.each(["runtime", "json", "html"])(
    "retains saved state when %s output fails",
    async (mode) => {
      const f = setup(async () => ({
        result:
          mode === "json"
            ? "invalid"
            : JSON.stringify({
                ...output(),
                html: mode === "html" ? "<br>".repeat(1001) : "OK",
              }),
        logs: "",
        error: mode === "runtime" ? "Synthetic timeout" : null,
      }))
      await expect(
        Effect.runPromise(f.web.interact(f.input, signal()))
      ).rejects.toThrow()
      expect(f.store.get(f.app.id)?.revision).toBe(f.app.revision)
      expect(f.store.pending()).toEqual([])
    }
  )
  it("retains a legacy record without web state and strips web state when its component is removed", async () => {
    const f = setup()
    const changed = await Effect.runPromise(f.web.interact(f.input, signal()))
    const draft = f.store.save({
      id: f.app.id,
      operationId: crypto.randomUUID(),
      expectedRevision: changed.revision,
      definition: {
        ...definition,
        blocks: [{ id: "text", type: "text", text: "Replacement" }],
      },
    })
    const published = f.store.publish({
      id: f.app.id,
      operationId: crypto.randomUUID(),
      expectedRevision: draft.revision,
      version: 2,
    })
    expect(published.state).toEqual({ checks: {}, forms: {} })
  })
})
