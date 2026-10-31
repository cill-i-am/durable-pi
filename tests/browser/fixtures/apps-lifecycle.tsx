import { useState } from "react"
import { createRoot } from "react-dom/client"

import { AppCanvas } from "../../../src/features/apps/app-canvas"
import { AppView } from "../../../src/features/apps/app-view"
import { useApp } from "../../../src/features/apps/use-app"
import { WebCanvas } from "../../../src/features/apps/web-canvas"

const id = "11111111-1111-4111-8111-111111111111"
const webId = "22222222-2222-4222-8222-222222222222"
const retained = new URLSearchParams(location.search).get("mode") === "retained"
const app = (agent: string, web = false) => ({
  id: web ? webId : id,
  version: 1,
  revision: 1,
  publishedVersion: 1,
  archived: false,
  createdAt: "2026-10-23",
  state: { checks: {}, forms: {} },
  definition: {
    title: agent,
    description: "",
    blocks: retained
      ? web
        ? [
            {
              id: "web",
              type: "web",
              code: "export default () => null",
              initialState: "{}",
            },
          ]
        : [
            {
              id: "form",
              type: "form",
              title: "Details",
              submitLabel: "Save form",
              fields: [
                {
                  id: "name",
                  label: "Name",
                  required: false,
                  multiline: false,
                },
              ],
            },
          ]
      : [{ id: "text", type: "text", text: agent }],
  },
})
const proof = {
  renders: 0,
  actions: 0,
  offline: false,
  calls: [] as { agent: string; path: string; body: unknown }[],
  release: () => {},
  setActive: (_active: boolean) => {},
}
Object.assign(window, { proof })
window.fetch = async (input, init) => {
  const url = new URL(String(input), location.href),
    agent = url.searchParams.get("agent") ?? "one"
  const body = init?.body ? JSON.parse(String(init.body)) : null
  const web = url.pathname.includes(webId) || body?.id === webId
  proof.calls.push({
    agent,
    path: url.pathname,
    body,
  })
  if (url.pathname.endsWith("/render")) {
    proof.renders++
    return Response.json({
      id: web ? webId : id,
      version: 1,
      revision: 1,
      html: '<input aria-label="Web draft"><button data-action="save">Save web</button>',
      css: "",
    })
  }
  if (init?.method === "POST" && proof.offline) {
    proof.offline = false
    throw new Error("synthetic response lost")
  }
  if (init?.method === "POST")
    return await new Promise<Response>((resolve) => {
      proof.release = () => resolve(Response.json(app(agent, web)))
    })
  return Response.json({
    app: app(agent, web),
    versions: [app(agent, web)],
    events: [],
  })
}
function Hook() {
  const [agent, setAgent] = useState("one"),
    state = useApp(agent, id)
  return (
    <>
      <button onClick={() => setAgent("two")}>Switch agent</button>
      <button
        onClick={() =>
          void state.mutate("apps/archive", {
            id,
            expectedRevision: 1,
            archived: true,
          })
        }
      >
        Save app
      </button>
      <button onClick={() => void state.retry()}>Retry change</button>
      <p data-error>{state.error}</p>
      <output>{state.detail?.app.definition.title ?? "loading"}</output>
    </>
  )
}
function Frame() {
  const [mounted, setMounted] = useState(true),
    [disabled, setDisabled] = useState(false),
    [revision, setRevision] = useState(1)
  return (
    <>
      <button onClick={() => setMounted(false)}>Remove frame</button>
      <button onClick={() => setDisabled((value) => !value)}>
        Toggle disabled
      </button>
      <button onClick={() => setRevision(2)}>Advance revision</button>
      {mounted && (
        <WebCanvas
          agentId="one"
          id={id}
          version={1}
          revision={revision}
          blockId="web"
          title="Web proof"
          disabled={disabled}
          onAction={() =>
            new Promise((resolve) => {
              proof.actions++
              proof.release = () => resolve(true)
            })
          }
        />
      )}
    </>
  )
}
function Form() {
  return (
    <AppCanvas
      agentId="one"
      id={id}
      version={1}
      revision={1}
      state={{ checks: {}, forms: {} }}
      disabled={false}
      definition={{
        title: "Form proof",
        description: "",
        blocks: [
          {
            id: "form",
            type: "form",
            title: "Details",
            submitLabel: "Save form",
            fields: [
              { id: "name", label: "Name", required: false, multiline: false },
            ],
          },
        ],
      }}
      onAction={() =>
        new Promise((resolve) => {
          proof.release = () => resolve(true)
        })
      }
    />
  )
}
function RetainedView() {
  const [active, setActive] = useState(true)
  proof.setActive = setActive
  return (
    <div hidden={!active} inert={!active}>
      <AppView agentId="one" id={id} active={active} />
      <AppView agentId="one" id={webId} active={active} />
    </div>
  )
}
const mode = new URLSearchParams(location.search).get("mode")
createRoot(document.getElementById("root")!).render(
  mode === "retained" ? (
    <RetainedView />
  ) : mode === "frame" ? (
    <Frame />
  ) : mode === "form" ? (
    <Form />
  ) : (
    <Hook />
  )
)
