import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { join, resolve } from "node:path"

await mkdir(".alchemy", { recursive: true })
const directory = await mkdtemp(resolve(".alchemy/dev-readiness-"))
const stage = directory.split("/").at(-1)
const config = join(directory, "alchemy.run.ts")
const backend = join(directory, "backend.ts")
const frontend = join(directory, "frontend.ts")
const marker = "Readiness fixture starts broken"
const cacheHandler = `async function cache(request) {
  const url = new URL(request.url);
  const key = new Request("https://cache.fixture/value");
  if (url.searchParams.has("value")) {
    await caches.default.put(key, new Response(url.searchParams.get("value"), {
      headers: { "cache-control": "public, max-age=3600" },
    }));
  }
  return (await caches.default.match(key)) ?? new Response("empty", { status: 404 });
}`
const healthyBackend = `${cacheHandler}
export default { fetch(request) {
  return new URL(request.url).pathname === "/cache"
    ? cache(request) : new Response("Backend ready");
} };`
let child
let output = ""

async function freePort() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function until(predicate) {
  for (let attempt = 0; attempt < 600; attempt++) {
    if (predicate()) return
    if (child.exitCode !== null)
      throw new Error(`Dev exited early: ${output.slice(-6000)}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Dev readiness timed out: ${output.slice(-6000)}`)
}

try {
  const backendPort = await freePort()
  const frontendPort = await freePort()
  await writeFile(
    backend,
    `throw new Error(${JSON.stringify(marker)});\n${healthyBackend}`
  )
  await writeFile(
    frontend,
    `${cacheHandler}
export default { fetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/cache") return cache(request);
  if (url.pathname === "/backend-cache") url.pathname = "/cache";
  return env.BACKEND.fetch(new Request(url, request));
} };`
  )
  await writeFile(
    config,
    `import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
const Backend = Cloudflare.Worker("Backend", {
  main: ${JSON.stringify(backend)},
  dev: { port: ${backendPort}, strictPort: true },
});
const Frontend = Cloudflare.Worker("Frontend", {
  main: ${JSON.stringify(frontend)},
  dev: { port: ${frontendPort}, strictPort: true },
  env: { BACKEND: Backend },
});
export default Alchemy.Stack("dev-readiness-fixture", {
  providers: Cloudflare.providers(),
  state: Alchemy.localState(),
}, Effect.gen(function* () { return { url: (yield* Frontend).url }; }));
`
  )
  child = spawn(
    process.execPath,
    [
      resolve("node_modules/alchemy/bin/cli.js"),
      "dev",
      config,
      "--stage",
      stage,
      "--no-input",
    ],
    { detached: true, stdio: ["ignore", "pipe", "pipe"] }
  )
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      output += chunk
    })

  await until(() => output.includes(marker))
  assert.doesNotMatch(output, /\[Backend\] ready at/, output.slice(-6000))
  assert.doesNotMatch(output, /Done: \d+ succeeded/, output.slice(-6000))

  await writeFile(backend, healthyBackend)
  await until(() => /Done: \d+ succeeded/.test(output))
  assert.ok(
    output.indexOf("[Backend] Started") < output.indexOf("[Backend] ready at"),
    output.slice(-6000)
  )
  const response = await fetch(`http://localhost:${frontendPort}`, {
    signal: AbortSignal.timeout(10_000),
  })
  assert.equal(response.status, 200)
  assert.equal(await response.text(), "Backend ready")
  async function cached(path, expected) {
    const response = await fetch(`http://localhost:${frontendPort}${path}`, {
      signal: AbortSignal.timeout(10_000),
    })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), expected)
  }
  await cached("/backend-cache?value=backend", "backend")
  await cached("/cache?value=frontend", "frontend")
  await cached("/backend-cache", "backend")
  output = ""
  await writeFile(
    backend,
    healthyBackend.replace("Backend ready", "Backend rebuilt")
  )
  await until(() => output.includes("[Backend] Updated"))
  await cached("/", "Backend rebuilt")
  await cached("/backend-cache", "backend")
  await cached("/cache", "frontend")
  console.log(
    "Local dev runtime passed: startup failure/repair, service readiness, private per-Worker caches and persistence across a rebuild."
  )
} finally {
  if (child && child.exitCode === null) {
    const closed = new Promise((resolve) => child.once("exit", resolve))
    process.kill(-child.pid, "SIGTERM")
    await closed
  }
  await rm(directory, { recursive: true, force: true })
  await rm(join(".alchemy/state/dev-readiness-fixture", stage), {
    recursive: true,
    force: true,
  })
}
