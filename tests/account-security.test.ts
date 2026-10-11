import { afterEach, describe, expect, it } from "vitest"
import { createHmac } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { readFileSync, readdirSync } from "node:fs"
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { drizzle } from "drizzle-orm/node-sqlite"
import { authOptions } from "../src/auth/server"
import * as schema from "../src/auth/schema"

const origin = "http://localhost:1337"
const password = "Only a disposable integration password 2026!"
const email = "security-test@example.com"
// An independent RFC 6238 authenticator: the URI carries base32, while Pi's
// native generateTOTP helper takes the pre-encoding string and is not an app endpoint.
export function authenticatorCode(secret: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
  const bits = [...secret.replace(/=+$/, "").toUpperCase()]
    .map((char) => alphabet.indexOf(char).toString(2).padStart(5, "0"))
    .join("")
  const key = Buffer.from(
    (bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2))
  )
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)))
  const hash = createHmac("sha1", key).update(counter).digest(),
    offset = hash[19]! & 15
  return (
    (new DataView(hash.buffer, hash.byteOffset, hash.byteLength).getUint32(
      offset
    ) &
      0x7fffffff) %
    1_000_000
  )
    .toString()
    .padStart(6, "0")
}
type TestBody = {
  totpURI: string
  backupCodes: string[]
  code: string
  twoFactorRedirect: boolean
  user: { twoFactorEnabled: boolean }
  session: { id: string; token: string }
  length: number
}
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function fixture() {
  const sql = new DatabaseSync(":memory:")
  databases.push(sql)
  for (const directory of readdirSync("migrations/auth").sort())
    sql.exec(readFileSync(`migrations/auth/${directory}/migration.sql`, "utf8"))
  const database = drizzleAdapter(drizzle({ client: sql }), {
    provider: "sqlite",
    schema,
  })
  const makeAuth = (ownerEmail = email) =>
    betterAuth({
      ...authOptions(
        {
          APP_URL: origin,
          OWNER_EMAIL: ownerEmail,
          BETTER_AUTH_SECRET:
            "test-secret-generated-only-for-isolated-security-tests-2026",
          AUTH_EMAIL: {
            send: async () => {
              throw new Error("No email transport in this fixture")
            },
          },
        },
        true
      ),
      database,
    })
  const auth = makeAuth()
  class Browser {
    jar = new Map<string, string>()
    constructor(readonly api = auth) {}
    async request(
      path: string,
      body?: unknown,
      extra?: Record<string, string>
    ) {
      const response = await this.api.handler(
        new Request(origin + "/api/auth" + path, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            origin,
            "content-type": "application/json",
            "user-agent": "Security test browser",
            "x-forwarded-for": `192.0.2.${Math.floor(Math.random() * 200) + 1}`,
            cookie: [...this.jar]
              .map(([name, value]) => `${name}=${value}`)
              .join("; "),
            ...extra,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
      )
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(";")[0]!,
          index = pair.indexOf("=")
        const name = pair.slice(0, index),
          value = pair.slice(index + 1)
        if (value) this.jar.set(name, value)
        else this.jar.delete(name)
      }
      return {
        status: response.status,
        data: await response.json<TestBody>(),
      }
    }
    login(ownerEmail = email) {
      return this.request("/sign-in/email", { email: ownerEmail, password })
    }
    session() {
      return this.request("/get-session")
    }
  }
  async function owner() {
    const browser = new Browser()
    expect(
      (
        await browser.request("/sign-up/email", {
          email,
          password,
          name: "Test owner",
        })
      ).status
    ).toBe(200)
    return browser
  }
  async function enroll(browser: Browser) {
    const started = await browser.request("/two-factor/enable", {
      password,
      method: "totp",
    })
    expect(started.status).toBe(200)
    const secret = new URL(started.data.totpURI).searchParams.get("secret")!
    const code = authenticatorCode(secret)
    expect(
      (await browser.request("/two-factor/verify-totp", { code })).status
    ).toBe(200)
    return { secret, codes: started.data.backupCodes }
  }
  return { sql, auth, makeAuth, Browser, owner, enroll }
}

describe("native Better Auth account security", () => {
  it("preserves the second factor across password recovery and invalidates old sessions", async () => {
    const f = fixture(),
      owner = await f.owner()
    await f.enroll(owner)
    const current = (await owner.session()).data.session
    const context = await f.auth.$context
    const signedIn = await context.internalAdapter.findSession(current.token)
    const token = crypto.randomUUID()
    await context.internalAdapter.createVerificationValue({
      identifier: `reset-password:${token}`,
      value: signedIn!.user.id,
      expiresAt: new Date(Date.now() + 60_000),
    })
    const replacement = "Another disposable integration password 2026!"
    const reset = new f.Browser()
    expect(
      (
        await reset.request("/reset-password", {
          token,
          newPassword: replacement,
        })
      ).status
    ).toBe(200)
    expect((await owner.session()).data).toBeNull()
    expect(
      (await reset.request("/sign-in/email", { email, password: replacement }))
        .data.twoFactorRedirect
    ).toBe(true)
    expect((await reset.session()).data).toBeNull()
  }, 20_000)
  it("does not revoke other browsers when an aged session refreshes during a failed factor change", async () => {
    const f = fixture(),
      owner = await f.owner()
    await f.enroll(owner)
    // Insert a second real session through the native adapter, as a prior successful sign-in.
    const current = (await owner.session()).data.session
    const context = await f.auth.$context
    const user = await context.internalAdapter.findSession(current.token)
    expect(user).not.toBeNull()
    const second = await context.internalAdapter.createSession(user!.user.id)
    expect(second).not.toBeNull()
    f.sql
      .prepare(
        "UPDATE session SET createdAt = ?, updatedAt = ?, expiresAt = ? WHERE id = ?"
      )
      .run(
        Date.now() - 2 * 86_400_000,
        Date.now() - 2 * 86_400_000,
        Date.now() + 5 * 86_400_000,
        current.id
      )
    expect(
      (await owner.request("/two-factor/disable", { password: "wrong" })).status
    ).toBe(400)
    expect(
      await context.internalAdapter.findSession(second.token)
    ).not.toBeNull()
    f.sql
      .prepare("UPDATE session SET updatedAt = ?, expiresAt = ? WHERE id = ?")
      .run(Date.now() - 2 * 86_400_000, Date.now() + 5 * 86_400_000, current.id)
    expect(
      (await owner.request("/two-factor/verify-totp", { code: "bad" })).status
    ).toBe(401)
    expect(
      await context.internalAdapter.findSession(second.token)
    ).not.toBeNull()
  }, 20_000)
  it("verifies enrollment before enforcing a factor, encrypts secrets and revokes older sessions", async () => {
    const f = fixture(),
      owner = await f.owner(),
      other = new f.Browser()
    await other.login()
    const start = await owner.request("/two-factor/enable", {
      password,
      method: "totp",
    })
    expect(start.status).toBe(200)
    expect((await owner.session()).data.user.twoFactorEnabled).toBe(false)
    expect(
      (await owner.request("/two-factor/verify-totp", { code: "bad" })).status
    ).toBe(401)
    const secret = new URL(start.data.totpURI).searchParams.get("secret")!
    const stored = f.sql
      .prepare('SELECT secret, backupCodes FROM "twoFactor"')
      .get()!
    expect(stored.secret === secret).toBe(false)
    expect(
      String(stored.backupCodes).includes(start.data.backupCodes[0]!)
    ).toBe(false)
    const code = authenticatorCode(secret)
    expect(
      (await owner.request("/two-factor/verify-totp", { code })).status
    ).toBe(200)
    expect((await owner.session()).data.user.twoFactorEnabled).toBe(true)
    expect((await other.session()).data).toBeNull()
    const challenge = new f.Browser()
    expect((await challenge.login()).data.twoFactorRedirect).toBe(true)
    expect((await challenge.session()).data).toBeNull()
    expect(
      (
        await challenge.request("/two-factor/verify-totp", {
          code,
          trustDevice: true,
        })
      ).status
    ).toBe(400)
    expect(
      (await challenge.request("/two-factor/verify-totp", { code })).status
    ).toBe(200)
    expect((await challenge.session()).data.user.twoFactorEnabled).toBe(true)
    expect((await owner.session()).data).not.toBeNull() // A normal 2FA sign-in does not revoke others.
    expect(
      (await challenge.request("/two-factor/disable", { password: "wrong" }))
        .status
    ).toBe(400)
    expect(
      (await challenge.request("/two-factor/disable", { password })).status
    ).toBe(200)
    expect((await challenge.session()).data.user.twoFactorEnabled).toBe(false)
    expect((await owner.session()).data).toBeNull()
    expect(
      f.sql.prepare('SELECT count(*) AS count FROM "twoFactor"').get()?.count
    ).toBe(0)
  }, 20_000)

  it("consumes recovery codes once across concurrent challenges and replaces old sets", async () => {
    const f = fixture(),
      owner = await f.owner(),
      { codes } = await f.enroll(owner)
    const a = new f.Browser(),
      b = new f.Browser()
    await a.login()
    await b.login()
    const results = await Promise.all(
      [a, b].map((browser) =>
        browser.request("/two-factor/verify-backup-code", { code: codes[0] })
      )
    )
    expect(results.filter((r) => r.status === 200)).toHaveLength(1)
    expect(results.every((r) => [200, 401, 409].includes(r.status))).toBe(true)
    const loser = results[0]!.status === 200 ? b : a
    expect((await loser.session()).data).toBeNull()
    const replay = new f.Browser()
    await replay.login()
    expect(
      (
        await replay.request("/two-factor/verify-backup-code", {
          code: codes[0],
        })
      ).status
    ).toBe(401)
    const replacement = await owner.request(
      "/two-factor/generate-backup-codes",
      { password }
    )
    expect(replacement.status).toBe(200)
    expect(
      (
        await replay.request("/two-factor/verify-backup-code", {
          code: codes[1],
        })
      ).status
    ).toBe(401)
    expect(
      (
        await replay.request("/two-factor/verify-backup-code", {
          code: replacement.data.backupCodes[0],
        })
      ).status
    ).toBe(200)
  }, 20_000)

  it("rejects expired/replayed challenges and limits failed second-factor attempts", async () => {
    const f = fixture(),
      owner = await f.owner(),
      { secret } = await f.enroll(owner)
    const expired = new f.Browser()
    await expired.login()
    f.sql
      .prepare("UPDATE verification SET expiresAt = ?")
      .run(Date.now() - 1000)
    const code = authenticatorCode(secret)
    expect(
      (await expired.request("/two-factor/verify-totp", { code })).status
    ).toBe(401)
    const browser = new f.Browser()
    await browser.login()
    const replay = new f.Browser()
    replay.jar = new Map(browser.jar)
    expect(
      (await browser.request("/two-factor/verify-totp", { code })).status
    ).toBe(200)
    expect(
      (await replay.request("/two-factor/verify-totp", { code })).status
    ).toBe(401)
    const limited = new f.Browser()
    await limited.login()
    for (let i = 0; i < 5; i++)
      expect(
        (await limited.request("/two-factor/verify-totp", { code: "bad" }))
          .status
      ).toBe(401)
    expect(
      (await limited.request("/two-factor/verify-totp", { code })).status
    ).toBe(400)
    expect((await limited.session()).data).toBeNull()
  }, 20_000)

  it("scopes revocation to the owner, revokes selected/other sessions and rejects stale management", async () => {
    const f = fixture(),
      owner = await f.owner(),
      a = new f.Browser(),
      b = new f.Browser()
    await a.login()
    await b.login()
    const other = new f.Browser(f.makeAuth("another-test@example.com"))
    await other.request("/sign-up/email", {
      email: "another-test@example.com",
      password,
      name: "Other",
    })
    const otherToken = (await other.session()).data.session.token
    expect(
      (await owner.request("/revoke-session", { token: otherToken })).status
    ).toBe(200)
    expect((await other.session()).data).not.toBeNull()
    const sessions = await owner.request("/list-sessions")
    expect(sessions.data.length).toBe(3)
    const token = (await a.session()).data.session.token
    expect((await owner.request("/revoke-session", { token })).status).toBe(200)
    expect((await a.session()).data).toBeNull()
    expect((await b.session()).data).not.toBeNull()
    expect((await owner.request("/revoke-other-sessions", {})).status).toBe(200)
    expect((await b.session()).data).toBeNull()
    const current = (await owner.session()).data.session
    f.sql
      .prepare("UPDATE session SET createdAt = ? WHERE id = ?")
      .run(Date.now() - 2 * 86_400_000, current.id)
    const stale = await owner.request("/list-sessions")
    expect(stale.status).toBe(403)
    expect(stale.data.code).toBe("SESSION_NOT_FRESH")
    expect(
      (
        await owner.request(
          "/two-factor/enable",
          { password },
          { origin: "https://foreign.example" }
        )
      ).status
    ).toBe(403)
  }, 20_000)
})
