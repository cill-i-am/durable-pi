import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose"
import { beforeAll, describe, expect, it } from "vitest"

import {
  returningCredential,
  returningSignInCallback,
  returningSignInUrl,
} from "../src/inference/adapters/sign-in-protocol"

const input = {
  clientId: "oaiapp_synthetic",
  hostId: "12345678-1234-4234-8234-123456789abc",
  redirectUri: "http://127.0.0.1:1456/auth/callback",
  state: "synthetic-state",
  nonce: "synthetic-nonce",
  verifier: "synthetic-verifier",
  expectedEmail: "owner@example.com",
}
describe("returning ChatGPT sign-in", () => {
  it("reuses the issued registration and host without requesting new registration", () => {
    const url = new URL(returningSignInUrl(input))
    expect(url.origin).toBe("https://auth.openai.com")
    expect(url.searchParams.get("client_id")).toBe(input.clientId)
    expect(url.searchParams.get("ext_agent_host_id")).toBe(
      `urn:uuid:${input.hostId}`
    )
    expect(url.searchParams.has("agent_name_hint")).toBe(false)
    expect(url.searchParams.get("redirect_uri")).toBe(input.redirectUri)
    expect(url.searchParams.get("code_challenge")).not.toBe(input.verifier)
  })
  it("accepts the documented callback without repeating the client ID", () => {
    expect(
      returningSignInCallback(
        `${input.redirectUri}?state=${input.state}&code=synthetic`,
        input
      )
    ).toBe("synthetic")
  })
  it("rejects changed state, registration, callback origin, duplicate codes and denial", () => {
    for (const value of [
      `${input.redirectUri}?state=wrong&code=synthetic`,
      `${input.redirectUri}?state=${input.state}&code=synthetic&client_id=another`,
      `${input.redirectUri}?state=${input.state}&code=synthetic&code=other`,
      `${input.redirectUri}?state=${input.state}&code=synthetic&state=${input.state}`,
      `${input.redirectUri}?state=${input.state}&error=access_denied`,
      `http://localhost:1456/auth/callback?state=${input.state}&code=synthetic`,
    ])
      expect(() => returningSignInCallback(value, input)).toThrow()
  })
  let pair: Awaited<ReturnType<typeof generateKeyPair>>
  let keys: ReturnType<typeof createLocalJWKSet>
  beforeAll(async () => {
    pair = await generateKeyPair("RS256")
    keys = createLocalJWKSet({
      keys: [{ ...(await exportJWK(pair.publicKey)), kid: "synthetic" }],
    })
  })
  const token = async (overrides: Record<string, unknown> = {}) => ({
    access_token: "synthetic-access",
    refresh_token: "synthetic-refresh",
    expires_in: 3600,
    scope: "openid chatgpt.tokens.use.direct",
    id_token: await new SignJWT({
      nonce: input.nonce,
      email: input.expectedEmail,
      email_verified: true,
      ...overrides,
    })
      .setProtectedHeader({ alg: "RS256", kid: "synthetic" })
      .setIssuer("https://auth.openai.com")
      .setAudience(input.clientId)
      .setSubject("synthetic-owner")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(pair.privateKey),
  })
  it("validates the signed identity, nonce and granted model scope", async () => {
    const result = await returningCredential(await token(), input, keys)
    expect(result).toMatchObject({
      type: "oauth",
      clientId: input.clientId,
      access: "synthetic-access",
    })
    expect(result.expires).toBeGreaterThan(Date.now())
  })
  it("rejects another owner or sign-in attempt", async () => {
    await expect(
      returningCredential(
        await token({ email: "other@example.com" }),
        input,
        keys
      )
    ).rejects.toThrow("identity")
    await expect(
      returningCredential(await token({ nonce: "other" }), input, keys)
    ).rejects.toThrow("identity")
    await expect(
      returningCredential(
        await token(),
        { ...input, clientId: "another" },
        keys
      )
    ).rejects.toThrow()
  })
  it("does not replace credentials without model permission and both rotating tokens", async () => {
    const valid = await token()
    await expect(
      returningCredential({ ...valid, scope: "openid" }, input, keys)
    ).rejects.toThrow("model access")
    await expect(
      returningCredential({ ...valid, refresh_token: "" }, input, keys)
    ).rejects.toThrow("incomplete")
  })
})
