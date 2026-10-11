import assert from "node:assert/strict"
import { Schema } from "effect"
import { AppDocument, AppDetail, WebPreview } from "../src/apps/contracts"

const origin = "http://localhost:1337"
assert.equal(process.env.OWNER_EMAIL, "workspace-test@example.com")
const login = await fetch(origin + "/api/auth/sign-in/email", {
  method: "POST",
  headers: { origin, "content-type": "application/json" },
  body: JSON.stringify({
    email: process.env.OWNER_EMAIL,
    password: "Local test password only 2026!",
  }),
})
assert.equal(login.status, 200)
const cookie = login.headers
  .getSetCookie()
  .map((value) => value.split(";")[0])
  .join("; ")
const bot = crypto.randomUUID(),
  keep = process.argv.includes("--keep-bot")
async function api(path: string, body?: unknown) {
  return fetch(`${origin}/api/agent/${path}?agent=${bot}`, {
    method: body ? "POST" : "GET",
    headers: { cookie, origin, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
}
const code = `
const state = input.state;
if(input.mode === 'action') {
  if(input.action.name === 'add') state.count++;
  if(input.action.name === 'save') state.note = input.action.values.dataset;
}
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
return {
 html: '<main><p class="eyebrow">A LITTLE EVERY DAY</p><h1>Reading journal</h1><p class="count">' + state.count + '<span> chapters this week</span></p><button type="button" data-action="add">Finished a chapter</button><hr><form data-action="save"><label for="note">A thought to keep</label><textarea id="note" name="dataset" placeholder="What stayed with you?">' + escape(state.note) + '</textarea><button>Save thought</button></form><p class="saved">Your journal stays with this bot.</p><details><summary>Fixture checks</summary><button type="button" data-action="constructor">Invalid action</button><button type="button" data-action="add">Valid action</button></details></main>',
 css: '.eyebrow{font-size:10px;letter-spacing:.15em;color:#728277}h1{font:600 26px/1.2 system-ui;margin:8px 0 26px}.count{font-size:40px;margin:12px 0}.count span{font-size:13px;color:#6b786e}button{background:#254834;color:#fff;border:0}hr{border:0;border-top:1px solid #e4e9e5;margin:26px 0}textarea{min-height:100px}.saved,details{font-size:12px;color:#728277;margin-top:24px}',
 state: JSON.stringify(state), summary: input.action?.name === 'save' ? 'Saved a reading note.' : 'Updated chapter count.'
};`
async function create(title: string, source: string) {
  const response = await api("apps/save", {
    id: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    expectedRevision: 0,
    definition: {
      title,
      description: "Synthetic local generated app",
      blocks: [
        {
          id: "journal",
          type: "web",
          code: source,
          initialState: JSON.stringify({ count: 0, note: "" }),
        },
      ],
    },
  })
  assert.equal(response.status, 200)
  let app = Schema.decodeUnknownSync(AppDocument)(await response.json())
  app = Schema.decodeUnknownSync(AppDocument)(
    await (
      await api("apps/publish", {
        id: app.id,
        operationId: crypto.randomUUID(),
        expectedRevision: app.revision,
        version: 1,
      })
    ).json()
  )
  return app
}
try {
  assert.equal(
    (
      await api("bots/create", {
        id: bot,
        name: "Web app verification",
        instructions: "",
      })
    ).status,
    200
  )
  let app = await create("Reading journal", code)
  const preview = Schema.decodeUnknownSync(WebPreview)(
    await (await api("apps/render", { id: app.id, version: 1 })).json()
  )
  assert.match(preview.html, /Reading journal/)
  assert.match(preview.html, /0<span>/)
  const input = {
    id: app.id,
    version: 1,
    operationId: crypto.randomUUID(),
    expectedRevision: app.revision,
    action: {
      type: "web",
      blockId: "journal",
      name: "save",
      values: { dataset: "Native Worker saved this thought." },
    },
  }
  app = Schema.decodeUnknownSync(AppDocument)(
    await (await api("apps/interact", input)).json()
  )
  assert.deepEqual(JSON.parse(app.state.web!.journal!), {
    count: 0,
    note: "Native Worker saved this thought.",
  })
  assert.deepEqual(await (await api("apps/interact", input)).json(), app)
  assert.equal(
    (await api("apps/interact", { ...input, operationId: crypto.randomUUID() }))
      .status,
    409
  )
  const detail = Schema.decodeUnknownSync(AppDetail)(
    await (await api(`apps/${app.id}`)).json()
  )
  assert.equal(detail.events.length, 1)
  assert.match(
    Schema.decodeUnknownSync(WebPreview)(
      await (await api("apps/render", { id: app.id, version: 1 })).json()
    ).html,
    /Native Worker saved/
  )
  for (const [name, source] of [
    ["Network blocked", "await fetch('https://example.com'); return {};"],
    ["Timeout", "await new Promise(() => {});"],
    ["Invalid output", "return {html:'Invalid result'};"],
  ] as const) {
    const failed = await create(name, source)
    assert.equal(
      (await api("apps/render", { id: failed.id, version: 1 })).status,
      409
    )
    assert.equal(
      (
        await api("apps/interact", {
          ...input,
          id: failed.id,
          expectedRevision: failed.revision,
          operationId: crypto.randomUUID(),
        })
      ).status,
      409
    )
    const unchanged = Schema.decodeUnknownSync(AppDetail)(
      await (await api(`apps/${failed.id}`)).json()
    )
    assert.equal(unchanged.app.revision, failed.revision)
    assert.equal(unchanged.events.length, 0)
    await api("apps/archive", {
      id: failed.id,
      expectedRevision: failed.revision,
      operationId: crypto.randomUUID(),
      archived: true,
    })
  }
  const cancel = crypto.randomUUID()
  await api("apps/cancel", { operationId: cancel })
  assert.equal(
    (
      await api("apps/interact", {
        ...input,
        operationId: cancel,
        expectedRevision: app.revision,
      })
    ).status,
    409
  )
  if (keep) console.log("Synthetic web app retained:", bot, app.id)
  console.log(
    "Generated app workerd E2E passed: native isolated render/action, persisted state, replay, conflict, cancelled admission, blocked network, timeout and malformed output retain prior state."
  )
} finally {
  if (!keep) await api("bots/archive", { id: bot, archived: true })
}
