import { createModels } from "@earendil-works/pi-ai/models"
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai"
import type { Credential, CredentialStore } from "@earendil-works/pi-ai"
import { readFile, writeFile, chmod } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline/promises"
import { stdin, stdout } from "node:process"

let stored: Credential | undefined
const credentials: CredentialStore = {
  read: async () => stored,
  list: async () =>
    stored ? [{ providerId: "openai", type: stored.type }] : [],
  modify: async (_id, fn) => {
    stored = await fn(stored)
    return stored
  },
  delete: async () => {
    stored = undefined
  },
}
const models = createModels({ credentials })
models.setProvider(openaiProvider())
const terminal = createInterface({ input: stdin, output: stdout })
let deviceId: string
try {
  deviceId = (await readFile(".agent-device-id.local", "utf8")).trim()
} catch {
  deviceId = randomUUID()
  await writeFile(".agent-device-id.local", deviceId, { mode: 0o600 })
}
try {
  await models.login(
    "openai",
    "oauth",
    {
      notify: (event) => {
        if (event.type === "auth_url")
          console.log(`Sign in in your browser:\n${event.url}`)
        else if (event.type === "info" || event.type === "progress")
          console.log(event.message)
      },
      prompt: (prompt) =>
        terminal.question(`${prompt.message}\n`, { signal: prompt.signal }),
    },
    { getDeviceId: () => deviceId }
  )
  if (!stored) throw new Error("Login did not complete")
  let env = ""
  try {
    env = await readFile(".env", "utf8")
  } catch {}
  env = env
    .split("\n")
    .filter((line) => !line.startsWith("OPENAI_CREDENTIAL="))
    .join("\n")
    .trimEnd()
  await writeFile(
    ".env",
    `${env}\nOPENAI_CREDENTIAL='${JSON.stringify(stored)}'\n`,
    { mode: 0o600 }
  )
  await chmod(".env", 0o600)
  console.log(
    "ChatGPT connected. Credential saved to ignored .env. Redeploy to update the private Worker secret."
  )
} finally {
  terminal.close()
}
