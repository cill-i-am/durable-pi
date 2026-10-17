import { readFile, stat } from "node:fs/promises"
import { createServer } from "node:http"
import { resolve, extname } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"

import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { Effect, Schema } from "effect"
import { build } from "vite"

import { encodeEventStream } from "../../src/auth/adapters/event-stream-encoding.ts"
import { chatMessages } from "../../src/conversations/adapters/tanstack.ts"
import { SendInput } from "../../src/conversations/contracts.ts"

const project = resolve(fileURLToPath(new URL("../..", import.meta.url)))
const output = process.env.PERF_DIST
  ? resolve(process.env.PERF_DIST)
  : resolve(project, "dist/performance")
if (!process.argv.includes("--serve-only"))
  await build({
    configFile: false,
    root: resolve(project, "scripts/performance"),
    resolve: { alias: { "@": resolve(project, "src") } },
    plugins: [tailwindcss(), react()],
    build: { outDir: output, emptyOutDir: true },
  })
if (process.argv.includes("--build-only")) process.exit(0)
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
const requests = []
// Read-only startup/recovery cases share the real UI and synthetic transports.
const startupCase = process.env.PERF_CASE
const journey = startupCase === "journey"
const sessions = new Map()
const fixtureEmail = "browser-smoke@example.invalid"
const fixturePassword = "Disposable browser fixture password 2026!"
const metadata = {
  model: "test",
  connected: true,
  memory: { messages: 20, summaries: 0, ready: true, notes: [] },
}
const messages = Array.from({ length: 20 }, (_, index) => {
  const turn = {
    id: `turn-${index}`,
    status: "done",
    error: null,
    created_at: "2026-10-15T00:00:00Z",
  }
  return [
    {
      id: `${turn.id}:request`,
      role: "user",
      content: "",
      parts: [{ type: "text", content: `Synthetic question ${index}` }],
      metadata: { durablePi: { turnId: turn.id, kind: "request", turn } },
    },
    {
      id: `${turn.id}:answer`,
      role: "assistant",
      content: "",
      parts: [
        {
          type: "text",
          content:
            `Synthetic response ${index}. ` +
            "A repeatable local performance fixture. ".repeat(100),
        },
      ],
      metadata: { durablePi: { turnId: turn.id, kind: "answer" } },
    },
  ]
}).flat()
// Activity is opt-in so the original text-only baseline stays reproducible.
// Closed reasoning/tool panels are the production rendering case this adds.
if (process.env.PERF_SCENARIO === "activity") {
  for (let index = 0; index < 20; index++) {
    const turnId = `turn-${index}`
    const position = messages.findIndex(
      (message) => message.id === `${turnId}:answer`
    )
    messages[position].metadata.durablePi.kind = "text"
    messages[position].metadata.durablePi.itemId = `${turnId}:answer`
    messages.splice(
      position,
      0,
      {
        id: `${turnId}:thinking`,
        role: "assistant",
        content: "",
        parts: [
          {
            type: "thinking",
            content: "A hidden reasoning fixture. ".repeat(80),
            stepId: `${turnId}:thinking`,
          },
          { type: "text", content: "" },
        ],
        metadata: {
          durablePi: { turnId, kind: "thinking", itemId: `${turnId}:thinking` },
        },
      },
      ...Array.from({ length: 2 }, (_, tool) => ({
        id: `${turnId}:tool-${tool}`,
        role: "assistant",
        content: "",
        parts: [
          {
            type: "tool-call",
            id: `${turnId}:call-${tool}`,
            name: "run_command",
            arguments: JSON.stringify({ command: "printf synthetic" }),
            state: "input-complete",
          },
          {
            type: "tool-result",
            toolCallId: `${turnId}:call-${tool}`,
            content: "A hidden tool result fixture. ".repeat(30),
            state: "complete",
          },
        ],
        metadata: {
          durablePi: {
            turnId,
            kind: "tool",
            itemId: `${turnId}:tool-${tool}`,
            toolStatus: "done",
          },
        },
      }))
    )
  }
}
const profile = {
  id: "home",
  name: "Navi",
  instructions: "Synthetic performance fixture",
  status: "active",
  revision: 1,
  createdAt: "today",
  updatedAt: "today",
}
const sendJson = (res, value) => {
  res.writeHead(200, {
    "content-type": "application/json",
    "cache-control": "no-store",
  })
  res.end(JSON.stringify(value))
}
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost")
  if (url.pathname === "/__measurements") return sendJson(res, requests)
  if (url.pathname.startsWith("/api/")) {
    const path = url.pathname
    const sessionId = req.headers.cookie?.match(
      /(?:^|; )pi_fixture=([^;]+)/
    )?.[1]
    const session = sessions.get(sessionId)
    if (journey && req.method === "POST") {
      if (await journeyPost(req, res, path, sessionId, session)) return
    }
    if (journey && path.startsWith("/api/agent/") && !session) {
      res.writeHead(401)
      res.end()
      return
    }
    if (req.method !== "GET") {
      res.writeHead(405)
      res.end()
      return
    }
    return fixtureGet(req, res, path, session)
  }
  try {
    const file = resolve(output, "." + decodeURIComponent(url.pathname))
    if (file !== output && !file.startsWith(output + "/")) {
      res.writeHead(404)
      res.end()
      return
    }
    const resource = await stat(file)
      .then((s) => (s.isFile() ? file : null))
      .catch(() => null)
    const body = await readFile(resource ?? resolve(output, "index.html"))
    const type =
      {
        ".js": "text/javascript",
        ".css": "text/css",
        ".html": "text/html",
        ".woff2": "font/woff2",
      }[extname(resource ?? "index.html")] ?? "application/octet-stream"
    const compressed = gzipSync(body)
    res.writeHead(200, {
      "content-type": type,
      "content-encoding": "gzip",
      "content-length": compressed.length,
      "cache-control": "no-store",
    })
    res.end(compressed)
  } catch {
    res.writeHead(500)
    res.end()
  }
})
server.listen(Number(process.argv[2] ?? 4397), "127.0.0.1", () =>
  console.log("Synthetic performance fixture ready")
)

async function journeyPost(req, res, path, sessionId, session) {
  if (path === "/api/agent/files/upload" && session) {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const form = await new Request("http://fixture/upload", {
      method: "POST",
      headers: { "content-type": req.headers["content-type"] },
      body: Buffer.concat(chunks),
    }).formData()
    const file = form.get("file")
    if (!(file instanceof File) || form.has("vision")) {
      res.writeHead(400)
      res.end()
      return true
    }
    const info = {
      id: form.get("id"),
      name: file.name,
      mime: file.type,
      kind: "image",
      size: file.size,
      createdAt: new Date().toISOString(),
      status: "ready",
      trashed: false,
    }
    session.files.set(info.id, {
      info,
      bytes: Buffer.from(await file.arrayBuffer()),
    })
    sendJson(res, info)
    return true
  }
  if (path === "/api/auth/sign-out") {
    sessions.delete(sessionId)
    res.setHeader(
      "set-cookie",
      "pi_fixture=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
    )
    sendJson(res, { success: true })
    return true
  }
  let body
  try {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    body = JSON.parse(Buffer.concat(chunks).toString())
  } catch {
    res.writeHead(400)
    res.end()
    return true
  }
  if (path === "/api/auth/sign-in/email") {
    if (body.email !== fixtureEmail || body.password !== fixturePassword) {
      res.writeHead(401, { "content-type": "application/json" })
      res.end(JSON.stringify({ message: "Email or password is incorrect" }))
      return true
    }
    const id = crypto.randomUUID()
    sessions.set(id, { messages: [], subscribers: new Set(), files: new Map() })
    res.setHeader(
      "set-cookie",
      `pi_fixture=${id}; Path=/; HttpOnly; SameSite=Lax`
    )
    sendJson(res, {
      redirect: false,
      token: "synthetic",
      user: { id: "benchmark-owner", name: "Bench", email: fixtureEmail },
    })
    return true
  }
  if (path === "/api/agent/send" && session) {
    try {
      const input = Schema.decodeUnknownSync(SendInput)(body)
      const images = (input.files ?? []).map((id) => session.files.get(id).info)
      session.messages.push(
        ...chatMessages([
          {
            id: input.operationId,
            text: input.text,
            answer: "Fixture reply received.",
            status: "done",
            error: null,
            created_at: new Date().toISOString(),
            attachments: images,
            images,
          },
        ])
      )
      for (const publish of session.subscribers) publish()
      sendJson(res, { accepted: true })
      return true
    } catch {
      res.writeHead(400)
      res.end()
      return true
    }
  }

  return false
}

async function fixtureGet(req, res, path, session) {
  requests.push({ path, at: Date.now() })
  if (requests.length > 1000) requests.shift()
  if (
    (startupCase === "catalog-error" && path === "/api/agent/bots") ||
    (startupCase === "conversation-error" && path === "/api/agent/events")
  ) {
    res.writeHead(503, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "Synthetic startup failure" }))
    return
  }
  if (path === "/api/auth/get-session") {
    return fixtureSession(res, session)
  }
  if (path === "/api/agent/bots") {
    await wait(startupCase === "catalog-slow" ? 2200 : 500)
    return sendJson(res, { agents: [profile] })
  }
  if (path === "/api/agent/whatsapp") {
    return sendJson(res, {
      configured: false,
      enabled: false,
      revision: 0,
      agentId: "home",
      agentName: "Home",
      contactUrl: null,
      messages: [],
    })
  }
  if (path === "/api/agent/bots/statuses") {
    await wait(100)
    return sendJson(res, {
      statuses: [{ agentId: "home", state: "ready", turnId: null }],
    })
  }
  if (path === "/api/agent/events") {
    await wait(100)
    if (res.destroyed) return
    const bytes = new TextEncoder()
    let cancelled = false,
      timer,
      publish
    const upstream = new Response(
      new ReadableStream({
        async start(controller) {
          controller.enqueue(
            bytes.encode(
              `data: ${JSON.stringify({ type: "MESSAGES_SNAPSHOT", messages: session?.messages ?? (startupCase === "empty" ? [] : messages) })}\n\n`
            )
          )
          if (startupCase === "metadata-slow") await wait(2200)
          if (cancelled) return
          controller.enqueue(
            bytes.encode(
              `data: ${JSON.stringify({ type: "CUSTOM", name: "durable-pi.metadata", value: metadata })}\n\n`
            )
          )
          if (session) {
            publish = () => {
              controller.enqueue(
                bytes.encode(
                  `data: ${JSON.stringify({ type: "MESSAGES_SNAPSHOT", messages: session.messages })}\n\n`
                )
              )
              controller.enqueue(
                bytes.encode(
                  `data: ${JSON.stringify({ type: "CUSTOM", name: "durable-pi.metadata", value: metadata })}\n\n`
                )
              )
            }
            session.subscribers.add(publish)
          }
          timer = setInterval(
            () => controller.enqueue(bytes.encode(": keepalive\n\n")),
            15000
          )
        },
        cancel() {
          cancelled = true
          clearInterval(timer)
          session?.subscribers.delete(publish)
        },
      }),
      {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
        },
      }
    )
    const response = await Effect.runPromise(
      encodeEventStream(
        new Request("http://fixture/api/agent/events", {
          headers: {
            "accept-encoding":
              process.env.PERF_COMPRESSION === "gzip" ? "gzip" : "identity",
          },
        }),
        upstream
      )
    )
    res.writeHead(200, Object.fromEntries(response.headers))
    try {
      await pipeline(Readable.fromWeb(response.body), res)
    } catch (cause) {
      if (!res.destroyed) res.destroy(cause)
    }
    return
  }
  if (path === "/api/agent/models") {
    await wait(250)
    return sendJson(res, {
      models: [],
      checkedAt: null,
      error: "Synthetic fixture",
      usage: "ChatGPT plan usage",
      selection: { model: "test", thinking: "medium", settingsRevision: 0 },
      assignments: {},
    })
  }
  if (path === "/api/agent/objects") return sendJson(res, { objects: [] })
  return fixtureFiles(res, path, session)
}

function fixtureFiles(res, path, session) {
  if (path === "/api/agent/files")
    return sendJson(res, {
      files: [...(session?.files.values() ?? [])].map((file) => file.info),
    })
  const image = path.match(/^\/api\/agent\/files\/([^/]+)\/(vision|content)$/)
  if (image && session?.files.has(image[1])) {
    const file = session.files.get(image[1])
    res.writeHead(200, { "content-type": file.info.mime })
    res.end(file.bytes)
    return
  }
  res.writeHead(404)
  res.end()
  return
}

async function fixtureSession(res, session) {
  await wait(startupCase === "session-slow" ? 30_000 : 150)
  if (startupCase === "anonymous" || (journey && !session))
    return sendJson(res, null)
  return sendJson(res, {
    user: {
      id: "benchmark-owner",
      name: "Bench",
      email: "benchmark@example.invalid",
      emailVerified: true,
      createdAt: "2026-10-15",
      updatedAt: "2026-10-15",
    },
    session: {
      id: "benchmark-session",
      userId: "benchmark-owner",
      token: "synthetic",
      expiresAt: "2099-01-01T00:00:00Z",
      createdAt: "2026-10-15",
      updatedAt: "2026-10-15",
    },
  })
}
