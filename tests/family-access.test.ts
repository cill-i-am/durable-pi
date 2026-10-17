import { readFileSync, readdirSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import type { WebsiteEnv } from "../alchemy.run"
import { authorizedMember, createAuth } from "../src/auth/server"
import { familyAgentAction } from "../src/family/adapters/agent-actions"
import { familyDirectory } from "../src/family/adapters/directory"
import { familyRequest } from "../src/family/adapters/http"
import { d1 } from "./d1"

const origin = "http://localhost:1337"
const ownerEmail = "owner@example.com"
const invitedEmail = "claire@example.com"
const password = "Disposable family integration password 2026!"
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function fixture() {
  const sql = new DatabaseSync(":memory:")
  databases.push(sql)
  for (const directory of readdirSync("migrations/auth").sort())
    sql.exec(readFileSync(`migrations/auth/${directory}/migration.sql`, "utf8"))
  const mail: { to: string; text: string }[] = []
  const suspended: string[] = []
  let failDelivery = false
  const env = {
    DB: d1(sql),
    APP_URL: origin,
    OWNER_EMAIL: ownerEmail,
    BETTER_AUTH_SECRET:
      "disposable-family-test-secret-with-at-least-32-characters",
    AUTH_EMAIL: {
      send: async (message: { to: string; text: string }) => {
        if (failDelivery) throw new Error("Synthetic delivery failure")
        mail.push(message)
        return { messageId: "fixture" }
      },
    },
    AGENT_SERVICE: {
      fetch: async (request: Request) => {
        suspended.push(request.headers.get("x-owner-id")!)
        return Response.json({ ok: true })
      },
    },
  } as unknown as WebsiteEnv
  const auth = createAuth(env, true)
  class Browser {
    cookies = new Map<string, string>()
    headers(extra: Record<string, string> = {}) {
      return {
        origin,
        "content-type": "application/json",
        cookie: [...this.cookies]
          .map(([key, value]) => `${key}=${value}`)
          .join("; "),
        "x-forwarded-for": `192.0.2.${Math.floor(Math.random() * 200) + 1}`,
        ...extra,
      }
    }
    request(path: string, body?: unknown, extra?: Record<string, string>) {
      return auth
        .handler(
          new Request(origin + "/api/auth" + path, {
            method: body === undefined ? "GET" : "POST",
            headers: this.headers(extra),
            body: body === undefined ? undefined : JSON.stringify(body),
          })
        )
        .then(async (response) => {
          for (const cookie of response.headers.getSetCookie()) {
            const pair = cookie.split(";")[0]!,
              index = pair.indexOf("=")
            if (pair.slice(index + 1))
              this.cookies.set(pair.slice(0, index), pair.slice(index + 1))
            else this.cookies.delete(pair.slice(0, index))
          }
          return {
            status: response.status,
            data: await response
              .json<{ id?: string; member?: { id: string } }>()
              .catch((): { id?: string; member?: { id: string } } => ({})),
          }
        })
    }
    authorized() {
      return Effect.runPromise(
        authorizedMember(
          new Request(origin + "/api/agent/state", { headers: this.headers() }),
          env
        )
      )
    }
    family() {
      return familyRequest(
        new Request(origin + "/api/family", { headers: this.headers() }),
        env
      )
    }
  }
  async function owner() {
    const browser = new Browser()
    expect(
      (
        await browser.request("/sign-up/email", {
          email: ownerEmail,
          name: "Cillian",
          password,
        })
      ).status
    ).toBe(200)
    return browser
  }
  async function invite(browser: Browser, email = invitedEmail) {
    const response = await browser.request("/organization/invite-member", {
      organizationId: "family",
      email,
      role: "member",
    })
    expect(response.status).toBe(200)
    return response.data.id as string
  }
  async function signup(id: string, email = invitedEmail) {
    const browser = new Browser()
    const response = await browser.request(
      "/sign-up/email",
      { email, name: "Claire", password },
      { "x-family-invitation": id }
    )
    expect(response.status).toBe(200)
    return browser
  }
  async function verify(browser: Browser) {
    const link = mail
      .slice()
      .reverse()
      .find(
        (message) =>
          message.to === invitedEmail && message.text.includes("#token=")
      )!
      .text.match(/http[^\s]+#token=[^\s]+/)![0]!
    const token = new URLSearchParams(new URL(link).hash.slice(1)).get("token")!
    return browser.request("/verify-email?token=" + encodeURIComponent(token))
  }
  return {
    sql,
    env,
    auth,
    mail,
    suspended,
    Browser,
    owner,
    invite,
    signup,
    verify,
    deliveryFails: (value: boolean) => {
      failDelivery = value
    },
  }
}

describe("family access with native Better Auth and production D1 queries", () => {
  it("requires an exact, unexpired invitation and verified email before private workspace access", async () => {
    const f = fixture(),
      owner = await f.owner()
    expect((await owner.authorized())?.email).toBe(ownerEmail)
    const outsider = new f.Browser()
    expect(
      (
        await outsider.request("/sign-up/email", {
          email: "stranger@example.com",
          name: "Stranger",
          password,
        })
      ).status
    ).not.toBe(200)
    const id = await f.invite(owner)
    expect(f.mail.at(-1)?.to).toBe(invitedEmail)
    expect(f.mail.at(-1)?.text).toContain("/join#invitation=")
    expect(
      (
        await outsider.request(
          "/sign-up/email",
          { email: "wrong@example.com", name: "Wrong", password },
          { "x-family-invitation": id }
        )
      ).status
    ).not.toBe(200)
    const member = await f.signup(id)
    expect(await member.authorized()).toBeNull()
    expect(
      (
        await member.request("/organization/accept-invitation", {
          invitationId: id,
        })
      ).status
    ).not.toBe(200)
    expect((await f.verify(member)).status).toBe(200)
    expect(
      (
        await member.request("/organization/accept-invitation", {
          invitationId: id,
        })
      ).status
    ).toBe(200)
    const person = await member.authorized()
    expect(person?.email).toBe(invitedEmail)
    expect(person?.id).not.toBe((await owner.authorized())?.id)
    const snapshot = await (
      await member.family()
    ).json<{ role: string; invitations: unknown[]; members: unknown[] }>()
    expect(snapshot.role).toBe("member")
    expect(snapshot.members).toHaveLength(2)
    expect(snapshot.invitations).toEqual([])
    expect(
      (
        await member.request("/organization/accept-invitation", {
          invitationId: id,
        })
      ).status
    ).not.toBe(200)
  })

  it("closes organization creation, role escalation and owner removal, including direct endpoint calls", async () => {
    const f = fixture(),
      owner = await f.owner(),
      id = await f.invite(owner),
      member = await f.signup(id)
    await f.verify(member)
    await member.request("/organization/accept-invitation", {
      invitationId: id,
    })
    for (const browser of [owner, member]) {
      expect(
        (
          await browser.request("/organization/create", {
            name: "Other",
            slug: "other",
          })
        ).status
      ).toBe(403)
      expect(
        (
          await browser.request("/organization/add-member", {
            organizationId: "family",
            userId: "someone",
            role: "owner",
          })
        ).status
      ).toBe(404)
      expect(
        (
          await browser.request("/organization/update-member-role", {
            organizationId: "family",
            memberId: "family-owner",
            role: "member",
          })
        ).status
      ).toBe(403)
    }
    expect(
      (
        await owner.request("/organization/invite-member", {
          organizationId: "family",
          email: "admin@example.com",
          role: "owner",
        })
      ).status
    ).toBe(403)
    expect(
      (
        await member.request("/organization/invite-member", {
          organizationId: "family",
          email: "other@example.com",
          role: "member",
        })
      ).status
    ).toBe(403)
    expect(
      (
        await member.request(
          "/organization/get-full-organization?organizationId=family"
        )
      ).status
    ).toBe(403)
    expect(
      (
        await owner.request("/organization/remove-member", {
          organizationId: "family",
          memberIdOrEmail: "family-owner",
        })
      ).status
    ).toBe(400)
  })

  it("revokes an existing session immediately on removal and notifies the private agent service", async () => {
    const f = fixture(),
      owner = await f.owner(),
      id = await f.invite(owner),
      member = await f.signup(id)
    await f.verify(member)
    const joined = await member.request("/organization/accept-invitation", {
      invitationId: id,
    })
    const userId = (await member.authorized())!.id
    expect(
      (
        await owner.request("/organization/remove-member", {
          organizationId: "family",
          memberIdOrEmail: joined.data.member!.id,
        })
      ).status
    ).toBe(200)
    expect(await member.authorized()).toBeNull()
    expect((await member.family()).status).toBe(403)
    expect(f.suspended).toEqual([userId])
    expect(
      f.sql.prepare("SELECT id FROM user WHERE id=?").get(userId)
    ).toBeDefined()
    expect(
      f.sql.prepare("SELECT id FROM session WHERE userId=?").get(userId)
    ).toBeDefined()
  })

  it("retains failed invitations for resend, and refuses cancelled or expired invitation signup", async () => {
    const f = fixture(),
      owner = await f.owner()
    f.deliveryFails(true)
    expect(
      (
        await owner.request("/organization/invite-member", {
          organizationId: "family",
          email: invitedEmail,
          role: "member",
        })
      ).status
    ).toBe(502)
    const saved = f.sql
      .prepare("SELECT id FROM invitation WHERE email=?")
      .get(invitedEmail)!
    f.deliveryFails(false)
    expect(
      (
        await owner.request("/organization/invite-member", {
          organizationId: "family",
          email: invitedEmail,
          role: "member",
          resend: true,
        })
      ).status
    ).toBe(200)
    expect(f.sql.prepare("SELECT count(*) AS n FROM invitation").get()?.n).toBe(
      1
    )
    const id = String(saved.id)
    f.sql.prepare("UPDATE invitation SET expiresAt=1 WHERE id=?").run(id)
    expect(
      await familyDirectory(f.env.DB, ownerEmail).pending(id, invitedEmail)
    ).toBe(false)
    expect(
      (
        await new f.Browser().request(
          "/sign-up/email",
          { email: invitedEmail, name: "Claire", password },
          { "x-family-invitation": id }
        )
      ).status
    ).not.toBe(200)
    expect(
      (
        await owner.request("/organization/cancel-invitation", {
          invitationId: id,
        })
      ).status
    ).toBe(200)
    expect(
      (await familyDirectory(f.env.DB, ownerEmail).preview(id))?.status
    ).toBe("unavailable")
  })

  it("runs chat invitations through native auth policy, rejects member mutation and cannot inject a principal into HTTP", async () => {
    const f = fixture(),
      owner = await f.owner()
    const ownerId = (await owner.authorized())!.id
    const sent = await Effect.runPromise(
      familyAgentAction(f.env, ownerId, {
        action: "invite",
        email: invitedEmail,
      })
    )
    expect(sent).toEqual({ status: "sent", email: invitedEmail })
    expect(
      f.mail.filter((message) => message.to === invitedEmail)
    ).toHaveLength(1)
    const id = String(
      f.sql
        .prepare("SELECT id FROM invitation WHERE email=?")
        .get(invitedEmail)!.id
    )
    const member = await f.signup(id)
    await f.verify(member)
    await member.request("/organization/accept-invitation", {
      invitationId: id,
    })
    const memberId = (await member.authorized())!.id
    await expect(
      Effect.runPromise(
        familyAgentAction(f.env, memberId, {
          action: "invite",
          email: "another@example.com",
          userId: ownerId,
        })
      )
    ).rejects.toBeDefined()
    const principal = f.sql
      .prepare("SELECT * FROM user WHERE id=?")
      .get(ownerId)!
    const invitationCount = f.sql
      .prepare("SELECT count(*) AS n FROM invitation")
      .get()!.n
    const auth = createAuth(f.env, false, undefined, {
      ...principal,
      emailVerified: false,
      twoFactorEnabled: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Parameters<typeof createAuth>[3])
    const spoofed = await auth.handler(
      new Request(origin + "/api/auth/organization/invite-member", {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          "x-owner-id": ownerId,
        },
        body: JSON.stringify({
          email: "spoof@example.com",
          organizationId: "family",
          role: "member",
        }),
      })
    )
    expect(spoofed.status).toBe(401)
    expect(f.sql.prepare("SELECT count(*) AS n FROM invitation").get()!.n).toBe(
      invitationCount
    )
  })

  it("renews an expired invitation without leaving duplicate pending invitations", async () => {
    const f = fixture(),
      owner = await f.owner(),
      id = await f.invite(owner)
    f.sql.prepare("UPDATE invitation SET expiresAt=1 WHERE id=?").run(id)
    const renewed = await owner.request("/organization/invite-member", {
      organizationId: "family",
      email: invitedEmail,
      role: "member",
      resend: true,
    })
    expect(renewed.status).toBe(200)
    expect(renewed.data.id).not.toBe(id)
    const snapshot = await (
      await owner.family()
    ).json<{ invitations: { id: string; status: string }[] }>()
    expect(snapshot.invitations).toEqual([
      expect.objectContaining({ id: renewed.data.id, status: "pending" }),
    ])
    expect(
      await familyDirectory(f.env.DB, ownerEmail).pending(id, invitedEmail)
    ).toBe(false)
  })

  it("fails closed on D1 failure and rejects cross-origin public invitation lookup", async () => {
    const f = fixture(),
      owner = await f.owner()
    const response = await familyRequest(
      new Request(origin + "/api/family/invitation", {
        method: "POST",
        headers: {
          origin: "https://untrusted.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ invitation: "guess" }),
      }),
      f.env,
      "invitation"
    )
    expect(response.status).toBe(403)
    f.sql.close()
    databases.splice(databases.indexOf(f.sql), 1)
    await expect(owner.authorized()).rejects.toBeDefined()
  })
})
