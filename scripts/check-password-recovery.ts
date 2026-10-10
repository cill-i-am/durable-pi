import assert from "node:assert/strict"
import { chmod, readdir, readFile } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"

// Destructive only to the disposable, credential-free LOCAL owner. Never accepts a remote URL.
const origin = "http://localhost:1337"
const owner = "workspace-test@example.com"
if (process.env.OWNER_EMAIL !== owner)
  throw new Error("Requires the isolated workspace-test owner")
const original = "Local test password only 2026!"
const replacement = "Another local-only password 2026!"
const mailDirectory = ".alchemy/local/email/text"
const dbDirectory = ".alchemy/local/d1/cloudflare-runtime-D1DatabaseObject"
const dbName = (await readdir(dbDirectory)).find((name) =>
  /^[a-f0-9]{64}\.sqlite$/.test(name)
)
assert.ok(dbName, "local auth database")
const db = new DatabaseSync(`${dbDirectory}/${dbName}`)
assert.equal(
  (db.prepare('SELECT email FROM "user" LIMIT 1').get() as { email: string })
    .email,
  owner
)
let sequence = 1
const ipPrefix = `192.0.${Math.floor(Math.random() * 250) + 1}`
async function post(
  path: string,
  body: unknown,
  options: { ip?: string; cookie?: string; origin?: string } = {}
) {
  return fetch(origin + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: options.origin ?? origin,
      "x-forwarded-for": options.ip ?? `${ipPrefix}.${sequence++}`,
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    body: JSON.stringify(body),
  })
}
async function files() {
  return readdir(mailDirectory).catch(() => [] as string[])
}
async function resetToken() {
  const before = new Set(await files())
  const response = await post("/api/auth/request-password-reset", {
    email: owner,
  })
  assert.equal(response.status, 200, "known owner request accepted")
  for (let attempt = 0; attempt < 50; attempt++) {
    const next = (await files()).find((name) => !before.has(name))
    if (next) {
      await chmod(`${mailDirectory}/${next}`, 0o600)
      const email = await readFile(`${mailDirectory}/${next}`, "utf8")
      const link = new URL(email.match(/http:\/\/\S+/)![0])
      assert.equal(link.origin, origin)
      assert.equal(link.pathname, "/reset-password")
      assert.equal(link.search, "", "no token in HTTP query")
      const token = new URLSearchParams(link.hash.slice(1)).get("token")!
      assert.ok(token)
      const record = db
        .prepare("SELECT expiresAt FROM verification WHERE identifier = ?")
        .get(`reset-password:${token}`) as { expiresAt: number }
      assert.ok(
        record.expiresAt > Date.now() + 14 * 60_000 &&
          record.expiresAt <= Date.now() + 15 * 60_000,
        "15 minute expiry"
      )
      return { token, response: await response.json() }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("Local email was not delivered")
}
function cookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ")
}
const login = await post("/api/auth/sign-in/email", {
  email: owner,
  password: original,
})
assert.equal(login.status, 200, "original credentials work")
const session = cookies(login)
assert.ok(session)
const count = (await files()).length
const unknown = await post("/api/auth/request-password-reset", {
  email: "unknown@example.com",
})
assert.equal(unknown.status, 200)
await new Promise((resolve) => setTimeout(resolve, 300))
assert.equal((await files()).length, count, "unknown account produces no email")
const first = await resetToken()
assert.deepEqual(
  await unknown.json(),
  first.response,
  "known and unknown responses identical"
)
assert.equal(
  (
    await post("/api/auth/request-password-reset", {
      email: owner,
      redirectTo: "https://attacker.example/reset",
    })
  ).status,
  403,
  "foreign callback rejected"
)
assert.equal(
  (
    await post(
      "/api/auth/request-password-reset",
      { email: owner },
      { origin: "https://attacker.example" }
    )
  ).status,
  403,
  "foreign origin rejected"
)
assert.equal(
  (
    await post("/api/auth/reset-password", {
      token: first.token,
      newPassword: "short",
    })
  ).status,
  400
)
// Race the same link: exactly one submission may change the password.
const raced = await Promise.all(
  [1, 2].map(() =>
    post("/api/auth/reset-password", {
      token: first.token,
      newPassword: replacement,
    })
  )
)
assert.deepEqual(
  raced.map((r) => r.status).sort(),
  [200, 400],
  "single-use token under concurrent replay"
)
assert.equal(
  (await fetch(origin + "/api/agent/bots", { headers: { cookie: session } }))
    .status,
  401,
  "old session revoked"
)
assert.equal(
  (await post("/api/auth/sign-in/email", { email: owner, password: original }))
    .status,
  401,
  "old password rejected"
)
const newLogin = await post("/api/auth/sign-in/email", {
  email: owner,
  password: replacement,
})
assert.equal(newLogin.status, 200, "replacement credentials work")
const expired = await resetToken()
db.prepare("UPDATE verification SET expiresAt = ? WHERE identifier = ?").run(
  Date.now() - 1000,
  `reset-password:${expired.token}`
)
assert.equal(
  (
    await post("/api/auth/reset-password", {
      token: expired.token,
      newPassword: original,
    })
  ).status,
  400,
  "expired token rejected"
)
const restore = await resetToken()
assert.equal(
  (
    await post("/api/auth/reset-password", {
      token: restore.token,
      newPassword: original,
    })
  ).status,
  200,
  "restore disposable password"
)
assert.equal(
  (
    await fetch(origin + "/api/agent/bots", {
      headers: { cookie: cookies(newLogin) },
    })
  ).status,
  401,
  "later reset also revokes sessions"
)
const limitedIp = `${ipPrefix}.250`
for (const expected of [200, 200, 200, 429])
  assert.equal(
    (
      await post(
        "/api/auth/request-password-reset",
        { email: "unknown@example.com" },
        { ip: limitedIp }
      )
    ).status,
    expected,
    "reset request rate limit"
  )
db.close()
console.log(
  "Password recovery workerd E2E passed: local email, private canonical link, anti-enumeration, CSRF/callback policy, expiry, concurrent single use, password change, session revocation, and rate limit."
)
