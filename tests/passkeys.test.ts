import { Effect } from "effect"
import { afterEach, expect, it } from "vitest"

import { passkeyAgentAction } from "../src/auth/adapters/passkey-actions"
import { createAuth } from "../src/auth/server"
import { passkeyFixture, responseCookies } from "./passkeys-fixture"

const fixtures: Awaited<ReturnType<typeof passkeyFixture>>[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) f.sql.close()
})
async function fixture() {
  const f = await passkeyFixture()
  fixtures.push(f)
  return f
}

it("requires a fresh, admitted browser session to register a passkey", async () => {
  const f = await fixture()
  expect((await f.request("/passkey/generate-register-options")).status).toBe(
    401
  )
  const fresh = await f.request(
    "/passkey/generate-register-options",
    f.ownerCookie
  )
  expect(fresh.status).toBe(200)
  expect(responseCookies(fresh)).toMatch(/passkey/)
  expect(await fresh.json()).toMatchObject({
    rp: { id: "localhost", name: "Pi" },
    authenticatorSelection: {
      userVerification: "required",
      residentKey: "required",
    },
  })
  f.sql
    .prepare("UPDATE session SET createdAt=? WHERE userId=?")
    .run(Date.now() - 2 * 86_400_000, f.owner)
  const stale = await f.request(
    "/passkey/generate-register-options",
    f.ownerCookie
  )
  expect(stale.status).toBe(403)
  expect(await stale.json()).toHaveProperty("code", "SESSION_NOT_FRESH")
  f.sql.prepare("DELETE FROM member WHERE userId=?").run(f.person)
  expect(
    (await f.request("/passkey/generate-register-options", f.personCookie))
      .status
  ).toBe(403)
})

it("requests device verification for sign-in and keeps a signed one-use challenge cookie", async () => {
  const f = await fixture()
  const options = await f.request("/passkey/generate-authenticate-options")
  expect(options.status).toBe(200)
  expect(await options.json()).toMatchObject({
    rpId: "localhost",
    userVerification: "required",
  })
  const cookie = responseCookies(options)
  expect(cookie).toMatch(/passkey/)
  const body = { response: { id: "missing-credential" } }
  expect(
    (await f.request("/passkey/verify-authentication", cookie, body)).status
  ).toBe(401)
  const replay = await f.request("/passkey/verify-authentication", cookie, body)
  expect(replay.status).toBe(400)
  expect(await replay.json()).toHaveProperty("code", "CHALLENGE_NOT_FOUND")
})

it("scopes native key listing, rename and removal to the authenticated person", async () => {
  const f = await fixture(),
    ownerKey = f.seedKey(f.owner),
    memberKey = f.seedKey(f.person)
  const listed = await f.request("/passkey/list-user-passkeys", f.personCookie)
  expect(listed.status).toBe(200)
  expect(await listed.json()).toMatchObject([{ id: memberKey }])
  for (const action of ["update-passkey", "delete-passkey"]) {
    expect(
      (
        await f.request(`/passkey/${action}`, f.personCookie, {
          id: ownerKey,
          name: "Wrong person",
        })
      ).ok
    ).toBe(false)
    expect(
      (
        await f.request(`/passkey/${action}`, f.ownerCookie, {
          id: memberKey,
          name: "Admin is not owner of this key",
        })
      ).ok
    ).toBe(false)
  }
  expect(
    (
      await f.request("/passkey/update-passkey", f.personCookie, {
        id: memberKey,
        name: "My laptop",
      })
    ).status
  ).toBe(200)
  expect(
    f.sql.prepare("SELECT name FROM passkey WHERE id=?").get(memberKey)
  ).toMatchObject({ name: "My laptop" })
  expect(
    (
      await f.request("/passkey/delete-passkey", f.personCookie, {
        id: memberKey,
      })
    ).status
  ).toBe(200)
  expect(
    f.sql.prepare("SELECT id FROM passkey WHERE id=?").get(ownerKey)
  ).toBeDefined()
})

it("chat projects safe key metadata, uses native ownership and never fabricates device enrollment", async () => {
  const f = await fixture(),
    ownerKey = f.seedKey(f.owner),
    memberKey = f.seedKey(f.person)
  const run = (user: string, input: unknown) =>
    Effect.runPromise(passkeyAgentAction(f.env, user, input))
  const read = await run(f.person, { action: "read" })
  expect(read).toMatchObject({ keys: [{ id: memberKey, name: "My phone" }] })
  expect(JSON.stringify(read)).not.toMatch(
    /publicKey|credentialID|synthetic-public-key|session|challenge/
  )
  await expect(
    run(f.person, { action: "remove", id: ownerKey, userId: f.owner })
  ).rejects.toBeDefined()
  await expect(
    run(f.owner, { action: "remove", id: memberKey })
  ).rejects.toBeDefined()
  expect(
    await run(f.person, {
      action: "rename",
      id: memberKey,
      name: " My phone key ",
    })
  ).toMatchObject({ status: "renamed", name: "My phone key" })
  expect(await run(f.person, { action: "setup" })).toMatchObject({
    status: "device_confirmation_required",
    url: "http://localhost:1337/agents/home/settings/security",
  })
  expect(
    f.sql.prepare("SELECT count(*) AS count FROM passkey").get()
  ).toMatchObject({ count: 2 })
  expect(
    await run(f.person, { action: "remove", id: memberKey })
  ).toMatchObject({ status: "removed", existingBrowserSessionsRetained: true })
  f.sql.prepare("DELETE FROM member WHERE userId=?").run(f.person)
  await expect(run(f.person, { action: "read" })).rejects.toBeDefined()
})

it("does not admit an agent principal to registration or let HTTP spoof that principal", async () => {
  const f = await fixture()
  const user = (await f.auth.api.getSession({
    headers: new Headers({ cookie: f.ownerCookie }),
  }))!.user
  const auth = createAuth(f.env, false, undefined, {
    ...user,
    image: user.image ?? null,
    twoFactorEnabled: user.twoFactorEnabled ?? false,
  })
  await expect(
    auth.api.generatePasskeyRegistrationOptions({
      headers: new Headers({ origin: f.env.APP_URL }),
    })
  ).rejects.toMatchObject({ status: "FORBIDDEN" })
  const forged = await auth.handler(
    new Request(f.env.APP_URL + "/api/auth/passkey/list-user-passkeys", {
      headers: { "x-owner-id": f.owner },
    })
  )
  expect(forged.status).toBe(401)
})
