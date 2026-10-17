import { createHash } from "node:crypto"

import { exportJWK, generateKeyPair, SignJWT } from "jose"

let keys: ReturnType<typeof generateKeyPair> | undefined
let exchanges = 0
let unexpected = 0
const material = () =>
  (keys ??= generateKeyPair("RS256", { extractable: true }))

export default {
  async fetch(request: Request) {
    const url = new URL(request.url)
    if (url.hostname !== "auth.openai.com") {
      unexpected++
      return new Response("Unexpected native outbound request", { status: 502 })
    }
    if (url.pathname === "/native-probe/inspect")
      return Response.json({ exchanges, unexpected })
    if (url.pathname === "/.well-known/jwks.json")
      return Response.json({
        keys: [
          {
            ...(await exportJWK((await material()).publicKey)),
            kid: "native-probe",
          },
        ],
      })
    if (url.pathname !== "/api/accounts/oauth/token")
      return new Response(null, { status: 404 })
    exchanges++
    const form = new URLSearchParams(await request.text())
    const code = JSON.parse(form.get("code")!) as {
      nonce: string
      challenge: string
      redirect: boolean
    }
    if (
      request.method !== "POST" ||
      form.get("grant_type") !== "authorization_code" ||
      form.get("resource") !== "https://api.openai.com/v1" ||
      !form.get("redirect_uri")?.startsWith("http://127.0.0.1:") ||
      createHash("sha256")
        .update(form.get("code_verifier")!)
        .digest("base64url") !== code.challenge
    )
      return Response.json({ error: "invalid_request" }, { status: 400 })
    if (code.redirect)
      return new Response(null, {
        status: 302,
        headers: { location: "https://unexpected.invalid/token" },
      })
    const idToken = await new SignJWT({
      nonce: code.nonce,
      email: "native@example.invalid",
      email_verified: true,
    })
      .setProtectedHeader({ alg: "RS256", kid: "native-probe" })
      .setIssuer("https://auth.openai.com")
      .setAudience(form.get("client_id")!)
      .setSubject("native-chatgpt-owner")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign((await material()).privateKey)
    return Response.json({
      access_token: "native-chatgpt-access",
      refresh_token: "native-chatgpt-refresh",
      expires_in: 3600,
      scope: "openid email offline_access chatgpt.tokens.use.direct",
      id_token: idToken,
    })
  },
}
