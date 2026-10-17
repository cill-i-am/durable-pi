import { readFileSync, readdirSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import { createAuth, type AuthEnv } from "../src/auth/server"
import { d1 } from "./d1"

export const passkeyPassword = "Disposable passkey integration password 2026!"
export const passkeyOwnerEmail = "owner@example.invalid"
export function responseCookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ")
}
export async function passkeyFixture(origin = "http://localhost:1337") {
  const sql = new DatabaseSync(":memory:")
  for (const directory of readdirSync("migrations/auth").sort())
    sql.exec(readFileSync(`migrations/auth/${directory}/migration.sql`, "utf8"))
  const env: AuthEnv = {
    DB: d1(sql),
    APP_URL: origin,
    OWNER_EMAIL: passkeyOwnerEmail,
    BETTER_AUTH_SECRET:
      "disposable-passkey-test-secret-with-at-least-32-characters",
    AUTH_EMAIL: { send: async () => ({ messageId: "synthetic" }) },
  }
  const auth = createAuth(env, true)
  async function request(
    path: string,
    cookie = "",
    body?: unknown,
    extra?: Record<string, string>
  ) {
    return auth.handler(
      new Request(origin + "/api/auth" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          origin,
          cookie,
          "content-type": "application/json",
          "x-forwarded-for": "192.0.2.7",
          ...extra,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    )
  }
  const signup = await request("/sign-up/email", "", {
    email: passkeyOwnerEmail,
    password: passkeyPassword,
    name: "Cillian",
  })
  if (!signup.ok) throw new Error("Could not create synthetic passkey owner")
  const owner = (await signup.json<{ user: { id: string } }>()).user.id
  const ownerCookie = responseCookies(signup)
  const person = crypto.randomUUID()
  const now = Date.now()
  // A second established member, with the same disposable password, lets the
  // native plugin prove ownership without repeating invitation-flow tests.
  sql
    .prepare(
      "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)"
    )
    .run(person, "Claire", "claire@example.invalid", 1, now, now)
  sql
    .prepare(
      "INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES(?,?,?,?,?)"
    )
    .run(crypto.randomUUID(), "family", person, "member", now)
  sql
    .prepare(
      "INSERT INTO account(id,accountId,providerId,userId,password,createdAt,updatedAt) SELECT ?,?,'credential',?,password,?,? FROM account WHERE userId=? AND providerId='credential'"
    )
    .run(crypto.randomUUID(), person, person, now, now, owner)
  const login = await request("/sign-in/email", "", {
    email: "claire@example.invalid",
    password: passkeyPassword,
  })
  if (!login.ok) throw new Error("Could not sign in synthetic passkey member")
  const personCookie = responseCookies(login)
  function seedKey(userId: string, name = "My phone") {
    const id = crypto.randomUUID()
    sql
      .prepare(
        "INSERT INTO passkey(id,name,publicKey,userId,credentialID,counter,deviceType,backedUp,createdAt) VALUES(?,?,?,?,?,?,?,?,?)"
      )
      .run(
        id,
        name,
        "synthetic-public-key",
        userId,
        crypto.randomUUID(),
        0,
        "multiDevice",
        1,
        now
      )
    return id
  }
  return {
    sql,
    env,
    auth,
    request,
    owner,
    ownerCookie,
    person,
    personCookie,
    seedKey,
  }
}
