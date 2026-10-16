import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"

const origin = process.env.SANDBOX_REHEARSAL_URL
assert(origin, "SANDBOX_REHEARSAL_URL is required")
const headers = {
  authorization: "Bearer " + process.env.SANDBOX_REHEARSAL_TOKEN,
  "content-type": "application/json",
}
const identity = randomBytes(32).toString("hex")
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function call(kind, path, body, owner = identity, expected) {
  const response = await fetch(origin + "/" + kind + "/" + owner + "/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  })
  if (expected) {
    assert.equal(response.status, expected, await response.clone().text())
    return
  }
  assert(
    response.ok,
    path + ": " + response.status + " " + (await response.clone().text())
  )
  return response.json()
}
async function settle(kind, id, owner = identity) {
  for (let n = 0; n < 240; n++) {
    const [run, state] = await Promise.all([
      call(kind, "terminal/" + id, undefined, owner),
      call(kind, "terminal", undefined, owner),
    ])
    if (run.status !== "running" && !state.busy) return run
    await pause(250)
  }
  throw Error("Command did not settle")
}
async function execute(kind, command) {
  const input = { id: randomUUID(), command }
  await call(kind, "terminal/run", input)
  return { input, result: await settle(kind, input.id) }
}
await call("legacy", "authority", {
  revision: 9,
  active: true,
  revokeThrough: 5,
})
const initial = await call("legacy", "terminal")
await call("legacy", "terminal/network", {
  revision: initial.networkPolicy.revision,
  unrestricted: false,
})
const saved = await execute(
  "legacy",
  "printf 'migrated café 🧭' > /workspace/migration-proof; printf 'history before migration'"
)
assert.equal(saved.result.status, "succeeded", JSON.stringify(saved.result))
const cancellation = randomUUID()
await call("legacy", "terminal/" + cancellation + "/cancel", {})
const receipt = await call("legacy", "migration/snapshot", {})
const frozen = await call("legacy", "migration/status")
assert.equal(frozen.phase, "snapshot")
assert.equal(frozen.running, false)
await call(
  "legacy",
  "terminal/run",
  { id: randomUUID(), command: "true" },
  identity,
  503
)
const imported = await call("native", "migration/import", receipt)
assert(imported.verified)
assert.equal(imported.sha256, receipt.sha256)
assert.deepEqual(await call("native", "migration/import", receipt), imported)
const restored = await call("native", "terminal")
assert.equal(restored.networkPolicy.unrestricted, false)
assert.equal(restored.runs.length, 1)
assert.equal(restored.runs[0].output, "history before migration")
await call("legacy", "migration/commit", receipt)
assert.equal((await call("legacy", "migration/status")).phase, "moved")
await call("native", "terminal/run", saved.input)
assert.equal((await call("native", "terminal")).runs.length, 1)
const proof = await execute("native", "cat /workspace/migration-proof")
assert.equal(proof.result.output, "migrated café 🧭")
await call("native", "terminal/run", {
  id: cancellation,
  command: "printf BAD > /workspace/migration-proof",
})
await pause(500)
assert.equal(
  (await execute("native", "cat /workspace/migration-proof")).result.output,
  "migrated café 🧭"
)
assert.equal(
  (await call("legacy", "terminal")).runs.length,
  (await call("native", "terminal")).runs.length
)
console.log(
  "PASS hosted migration: source frozen and drained; authority, policy, history, checkpoint, cancellation and replay preserved; repeated import idempotent; source gateway forwards after commit."
)

const owners = Array.from({ length: 5 }, () => randomBytes(32).toString("hex"))
const sessions = owners.map(() => randomUUID())
try {
  for (let i = 0; i < 4; i++) {
    await call("native", "authority", { revision: 1, active: true }, owners[i])
    await call("native", "terminal/session", { id: sessions[i] }, owners[i])
    for (let n = 0; n < 200; n++) {
      const state = await call("native", "terminal", undefined, owners[i])
      if (state.session?.phase === "ready") break
      assert(state.busy, JSON.stringify(state))
      assert(n < 199, "Session did not become ready")
      await pause(250)
    }
  }
  const capacity = await fetch(origin + "/native/capacity", { headers }).then(
    (r) => r.json()
  )
  assert.deepEqual(capacity, { used: 4, maximum: 4 })
  await call("native", "authority", { revision: 1, active: true }, owners[4])
  await call(
    "native",
    "terminal/run",
    { id: sessions[4], command: "true" },
    owners[4]
  )
  assert.equal(
    (await settle("native", sessions[4], owners[4])).status,
    "failed"
  )
  assert.deepEqual(
    await fetch(origin + "/native/capacity", { headers }).then((r) => r.json()),
    capacity
  )
} finally {
  for (let i = 0; i < owners.length; i++)
    await call("native", "terminal/" + sessions[i] + "/cancel", {}, owners[i])
}
for (let n = 0; n < 100; n++) {
  const capacity = await fetch(origin + "/native/capacity", { headers }).then(
    (r) => r.json()
  )
  if (capacity.used === 0) break
  assert(n < 99, "Native capacity was not released after teardown")
  await pause(250)
}
console.log(
  "PASS hosted capacity: four native containers; fifth denied; all permits released after confirmed teardown."
)
