import { createHash } from "node:crypto"

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose"

const issuer = "https://auth.openai.com"
const keys = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`))

export interface ReturningSignIn {
  clientId: string
  hostId: string
  redirectUri: string
  state: string
  nonce: string
  verifier: string
}

export function returningSignInUrl(input: ReturningSignIn) {
  if (!input.clientId.trim() || input.clientId === "dynamic_agent_client")
    throw new Error("Use the issued client ID from an existing Pi connection.")
  if (!/^[a-f0-9-]{36}$/i.test(input.hostId))
    throw new Error("The existing Pi host ID is required.")
  const url = new URL(`${issuer}/api/accounts/authorize`)
  url.search = new URLSearchParams({
    client_id: input.clientId,
    ext_agent_host_id: `urn:uuid:${input.hostId.toLowerCase()}`,
    redirect_uri: input.redirectUri,
    response_type: "code",
    resource: "https://api.openai.com/v1",
    scope:
      "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    state: input.state,
    nonce: input.nonce,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256")
      .update(input.verifier)
      .digest("base64url"),
  }).toString()
  return url.toString()
}

export function returningSignInCallback(
  value: string,
  input: Pick<ReturningSignIn, "redirectUri" | "state" | "clientId">
) {
  const url = new URL(value)
  const redirect = new URL(input.redirectUri)
  if (
    url.origin !== redirect.origin ||
    url.pathname !== redirect.pathname ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.searchParams.getAll("state").length !== 1 ||
    url.searchParams.get("state") !== input.state
  )
    throw new Error("This callback does not belong to the pending sign-in.")
  if (url.searchParams.has("error"))
    throw new Error("ChatGPT did not authorize this connection.")
  const clientId = url.searchParams.get("client_id")
  if (
    url.searchParams.getAll("client_id").length > 1 ||
    (clientId !== null && clientId !== input.clientId)
  )
    throw new Error("The callback changed the selected Pi registration.")
  const code = url.searchParams.get("code")
  if (!code || url.searchParams.getAll("code").length !== 1)
    throw new Error("The callback did not contain one authorization code.")
  return code
}

export async function returningCredential(
  raw: unknown,
  input: Pick<ReturningSignIn, "clientId" | "nonce"> & {
    expectedEmail: string
    expectedSubject?: string
  },
  verificationKey: JWTVerifyGetKey = keys
) {
  const token = raw as Record<string, unknown> | null
  if (
    !token ||
    typeof token.access_token !== "string" ||
    !token.access_token.trim() ||
    typeof token.refresh_token !== "string" ||
    !token.refresh_token.trim() ||
    typeof token.id_token !== "string" ||
    typeof token.scope !== "string" ||
    typeof token.expires_in !== "number" ||
    !Number.isFinite(token.expires_in) ||
    token.expires_in <= 180
  )
    throw new Error("ChatGPT returned an incomplete credential.")
  const { payload } = await jwtVerify(token.id_token, verificationKey, {
    issuer,
    audience: input.clientId,
    algorithms: ["RS256"],
    requiredClaims: ["sub", "exp", "iat", "nonce", "email"],
  })
  if (
    payload.nonce !== input.nonce ||
    typeof payload.email !== "string" ||
    payload.email.toLowerCase() !== input.expectedEmail.toLowerCase() ||
    payload.email_verified !== true ||
    (input.expectedSubject !== undefined &&
      payload.sub !== input.expectedSubject)
  )
    throw new Error("ChatGPT identity does not match the selected Pi owner.")
  const scopes = token.scope.trim().split(/\s+/)
  if (!scopes.includes("chatgpt.tokens.use.direct"))
    throw new Error("ChatGPT did not grant model access.")
  return {
    type: "oauth" as const,
    clientId: input.clientId,
    access: token.access_token,
    refresh: token.refresh_token,
    expires: Date.now() + token.expires_in * 1000 - 180_000,
    scopes,
    identity: { issuer, subject: payload.sub!, email: payload.email },
  }
}
