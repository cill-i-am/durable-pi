import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { createServer } from "node:net"
import { dirname, join } from "node:path"
const root = process.cwd(),
  req = createRequire(root + "/package.json"),
  alchemy = createRequire(req.resolve("alchemy"))
const { build } = alchemy("esbuild"),
  workerd = alchemy("workerd")
const dir = await mkdtemp("/tmp/upstream-rpc-control-")
let child,
  output = ""
const server = createServer()
await new Promise((r) => server.listen(0, "127.0.0.1", r))
const port = server.address().port
await new Promise((r) => server.close(r))
try {
  await mkdir(dir + "/storage")
  await build({
    entryPoints: [root + "/tests/runtime/upstream-worker.ts"],
    outfile: dir + "/worker.mjs",
    bundle: true,
    format: "esm",
    platform: "node",
    external: ["cloudflare:*"],
    logLevel: "error",
  })
  const schema = join(
    dirname(alchemy.resolve("workerd")),
    "..",
    "workerd.capnp"
  )
  await writeFile(
    dir + "/fixture.capnp",
    `using Workerd=import ${JSON.stringify(schema)};const config:Workerd.Config=(services=[(name="fixture",worker=(compatibilityDate=${JSON.stringify(workerd.compatibilityDate)},compatibilityFlags=["nodejs_compat","legacy_module_registry"],modules=[(name="worker.mjs",esModule=embed "worker.mjs")],globalOutbound="upstream",bindings=[(name="DELAY",service="upstream"),(name="PROBE",durableObjectNamespace=(className="UpstreamProbe"))],durableObjectNamespaces=[(className="UpstreamProbe",uniqueKey="upstream-rpc-control",enableSql=true)],durableObjectStorage=(localDisk="storage"))),(name="upstream",worker=(compatibilityDate=${JSON.stringify(workerd.compatibilityDate)},compatibilityFlags=["nodejs_compat","legacy_module_registry"],modules=[(name="worker.mjs",esModule=embed "worker.mjs")])),(name="storage",disk=(path="storage",writable=true))],sockets=[(name="http",address="127.0.0.1:${port}",http=(),service="fixture")]);`
  )
  child = spawn(
    workerd.default,
    ["serve", "--experimental", "-I/", "fixture.capnp"],
    { cwd: dir, stdio: ["ignore", "pipe", "pipe"] }
  )
  child.stdout.on("data", (x) => (output += x))
  child.stderr.on("data", (x) => {
    output += x
    process.stderr.write(x)
  })
  const origin = "http://127.0.0.1:" + port
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(origin + "/health")).ok) break
    } catch {}
    await new Promise((r) => setTimeout(r, 50))
  }
  const results = []
  assert.deepEqual(
    await (
      await fetch(origin + "/race-eof", { signal: AbortSignal.timeout(5000) })
    ).json(),
    {
      statuses: ["fulfilled", "fulfilled"],
      closes: 1,
      disposals: 1,
    }
  )
  for (const mode of [
    "baseline",
    "gate",
    "unread",
    "abort-headers",
    "cancel-body",
    "slow-observer",
    "past-expiry",
  ]) {
    const response = await fetch(origin + "/observe?mode=" + mode, {
        signal: AbortSignal.timeout(mode === "past-expiry" ? 65_000 : 5000),
      }),
      reader = response.body.getReader(),
      markers = []
    let buffer = ""
    const consume = (async () => {
      for (;;) {
        const next = await reader.read()
        if (next.done) return
        buffer += new TextDecoder().decode(next.value)
        let end
        while ((end = buffer.indexOf("\n")) >= 0) {
          if (buffer.startsWith("data: "))
            markers.push({
              ...JSON.parse(buffer.slice(6, end)),
              at: performance.now(),
            })
          buffer = buffer.slice(end + 1)
        }
      }
    })().catch(() => {})
    for (let tries = 0; !markers.some((x) => x.stage === "ready"); tries++) {
      assert(tries < 400, "Observer ready deadline exceeded")
      await new Promise((r) => setTimeout(r, 10))
    }
    const start = performance.now()
    const reply = await fetch(origin + "/run?mode=" + mode, {
      signal: AbortSignal.timeout(mode === "past-expiry" ? 65_000 : 5000),
    })
    const text = await reply.text()
    if (
      ["baseline", "gate", "unread", "slow-observer", "past-expiry"].includes(
        mode
      )
    ) {
      assert.equal(reply.status, 202)
      assert.equal(reply.headers.get("x-upstream"), "retained")
      assert.equal(
        text,
        ': headers\n\ndata: {"type":"response.output_text.delta","delta":"synthetic"}\n\n'
      )
    } else assert.equal(text, "cancelled")
    const actorDone = performance.now()
    if (mode === "slow-observer") {
      for (
        let tries = 0;
        !markers.some((marker) => marker.stage === "complete");
        tries++
      ) {
        assert(tries < 300, "Slow observer flush deadline exceeded")
        await new Promise((done) => setTimeout(done, 10))
      }
    }
    await new Promise((r) => setTimeout(r, 50))
    results.push({
      mode,
      actorDoneMs: actorDone - start,
      markers: markers.map((x) => ({ ...x, afterSendMs: x.at - start })),
    })
    await reader.cancel()
    await consume
  }
  console.log(JSON.stringify(results, null, 2))
  await writeFile(
    process.env.PI_UPSTREAM_EVIDENCE ?? dir + "/evidence.json",
    JSON.stringify(results, null, 2)
  )
  for (const row of results.filter((x) => ["gate", "unread"].includes(x.mode)))
    assert(
      row.markers.find((x) => x.stage === "upstream-text").afterSendMs <
        row.actorDoneMs - 350
    )
  assert(results.find((x) => x.mode === "abort-headers").actorDoneMs < 500)
  const slow = results.find((row) => row.mode === "slow-observer")
  assert(
    results.find((row) => row.mode === "past-expiry").actorDoneMs > 60_000,
    "Long inference must survive observer expiry"
  )
  assert(slow.actorDoneMs < 500, "Diagnostic backpressure delayed inference")
  assert(
    slow.markers.some((marker) => marker.stage === "upstream-text"),
    "Slow diagnostic lost upstream observation"
  )
  console.log(
    "Independent upstream, actor gate, unread consumer, pre-header abort and body cancellation controls passed."
  )
} catch (e) {
  console.error(output)
  throw e
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const stopped = new Promise((r) => child.once("exit", r))
    child.kill("SIGTERM")
    await stopped
  }
  await rm(dir, { recursive: true, force: true })
}
