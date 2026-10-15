import { createServer } from "node:http"
import { readFile, stat } from "node:fs/promises"
import { resolve, extname } from "node:path"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"
import { build } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

const project = resolve(fileURLToPath(new URL("../..", import.meta.url)))
const output = resolve(project, "dist/performance")
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
    if (req.method !== "GET") {
      res.writeHead(405)
      res.end()
      return
    }
    const path = url.pathname
    requests.push({ path, at: Date.now() })
    if (requests.length > 1000) requests.shift()
    if (path === "/api/auth/get-session") {
      await wait(150)
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
    if (path === "/api/agent/bots") {
      await wait(500)
      return sendJson(res, { agents: [profile] })
    }
    if (path === "/api/agent/bots/statuses") {
      await wait(100)
      return sendJson(res, {
        statuses: [{ agentId: "home", state: "ready", turnId: null }],
      })
    }
    if (path === "/api/agent/events") {
      await wait(100)
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
      })
      res.write(
        `data: ${JSON.stringify({ type: "MESSAGES_SNAPSHOT", messages })}\n\n`
      )
      res.write(
        `data: ${JSON.stringify({ type: "CUSTOM", name: "durable-pi.metadata", value: metadata })}\n\n`
      )
      const timer = setInterval(() => res.write(": keepalive\n\n"), 15000)
      req.on("close", () => clearInterval(timer))
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
    if (path === "/api/agent/files") return sendJson(res, { files: [] })
    res.writeHead(404)
    res.end()
    return
  }
  try {
    const file = resolve(output, "." + decodeURIComponent(url.pathname))
    if (!file.startsWith(output + "/")) {
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
