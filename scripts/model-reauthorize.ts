import { randomBytes, randomUUID } from "node:crypto"
import { readFile, rename, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { parseArgs } from "node:util"

import {
  returningCredential,
  returningSignInCallback,
  returningSignInUrl,
  type ReturningSignIn,
} from "../src/inference/adapters/sign-in-protocol"

const { values } = parseArgs({
  options: {
    "credential-file": { type: "string" },
    "device-file": { type: "string", default: ".agent-device-id.local" },
    "env-file": { type: "string", default: ".env" },
    "expected-email": { type: "string" },
  },
})
if (!values["credential-file"] || !values["expected-email"])
  throw new Error("Provide --credential-file and --expected-email.")
const source = await readFile(values["credential-file"], "utf8")
const line = source
  .split("\n")
  .find((value) => value.startsWith("OPENAI_CREDENTIAL="))
if (!line) throw new Error("The selected file has no Pi registration.")
const existing: unknown = JSON.parse(
  line.slice("OPENAI_CREDENTIAL=".length).trim().replace(/^'|'$/g, "")
)
if (
  !existing ||
  typeof existing !== "object" ||
  !("clientId" in existing) ||
  typeof existing.clientId !== "string"
)
  throw new Error("The saved Pi credential has no issued client ID.")
const hostId = (await readFile(values["device-file"], "utf8")).trim()
const random = () => randomBytes(32).toString("base64url")
const input: ReturningSignIn = {
  clientId: existing.clientId,
  hostId,
  redirectUri: "",
  state: random(),
  nonce: random(),
  verifier: random(),
}
let acceptCode!: (code: string) => void
const code = new Promise<string>((resolve) => {
  acceptCode = resolve
})
const server = createServer((request, response) => {
  try {
    if (request.method !== "GET") throw new Error("Use the sign-in callback.")
    const received = returningSignInCallback(
      new URL(request.url ?? "", input.redirectUri).toString(),
      input
    )
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
    response.end(
      "Authorization received. Return to Pi to confirm reconnection."
    )
    acceptCode(received)
  } catch {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" })
    response.end(
      "This callback could not be verified. Return to the Pi sign-in."
    )
  }
})
try {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("Could not start the local sign-in callback.")
  input.redirectUri = `http://127.0.0.1:${address.port}/auth/callback`
  console.log(`Sign in in your browser:\n${returningSignInUrl(input)}`)
  const timeout = AbortSignal.timeout(600_000)
  const received = await new Promise<string>((resolve, reject) => {
    void code.then(resolve, reject)
    timeout.addEventListener(
      "abort",
      () => reject(new Error("Sign-in expired.")),
      {
        once: true,
      }
    )
  })
  const response = await fetch(
    "https://auth.openai.com/api/accounts/oauth/token",
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: input.clientId,
        code: received,
        code_verifier: input.verifier,
        redirect_uri: input.redirectUri,
        resource: "https://api.openai.com/v1",
      }),
    }
  )
  if (!response.ok)
    throw new Error(`ChatGPT code exchange failed (${response.status}).`)
  const credential = await returningCredential(await response.json(), {
    ...input,
    expectedEmail: values["expected-email"],
  })
  let env = ""
  try {
    env = await readFile(values["env-file"], "utf8")
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT"))
      throw cause
  }
  env = env
    .split("\n")
    .filter((value) => !value.startsWith("OPENAI_CREDENTIAL="))
    .join("\n")
    .trimEnd()
  const temporary = `${values["env-file"]}.${randomUUID()}.tmp`
  await writeFile(
    temporary,
    `${env}\nOPENAI_CREDENTIAL='${JSON.stringify(credential)}'\n`,
    {
      mode: 0o600,
      flag: "wx",
    }
  )
  await rename(temporary, values["env-file"])
  console.log(
    "ChatGPT reconnected. Validated credential saved privately; ready to deploy."
  )
} finally {
  server.close()
  server.closeAllConnections()
}
