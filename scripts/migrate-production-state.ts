import { readFile } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { makeHttpStateStore } from "alchemy/State/HttpStateStore"
import { makeLocalState } from "alchemy/State/LocalState"
import { encodeState } from "alchemy/State/StateEncoding"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

// One-time, copy-only migration. Keep the local state as a private backup.
// Conflicting remote state is never overwritten; a partial copy can be resumed.
const credentialsPath = process.argv[2]
if (!credentialsPath)
  throw new Error("Pass the private Alchemy state credentials file path")
const credentials = Schema.decodeUnknownSync(
  Schema.Struct({
    url: Schema.String,
    authToken: Schema.String,
    accountId: Schema.String,
  })
)(JSON.parse(await readFile(credentialsPath, "utf8")))
if (credentials.accountId !== process.env.CLOUDFLARE_ACCOUNT_ID) {
  throw new Error(
    "State credentials do not match the expected Cloudflare account"
  )
}
const apply = process.argv.includes("--apply")
const target = { stack: "durable-pi", stage: "production" }
await Effect.runPromise(
  Effect.gen(function* () {
    const local = yield* makeLocalState()
    const remote = yield* makeHttpStateStore({
      ...credentials,
      id: "cloudflare-http",
    })
    const keys = yield* local.list(target)
    if (keys.length === 0) throw new Error("Local production state is missing")
    const extra = (yield* remote.list(target)).filter(
      (key) => !keys.includes(key)
    )
    if (extra.length)
      throw new Error("Remote state contains unexpected production resources")
    const entries = []
    for (const fqn of keys) {
      const key = { ...target, fqn }
      const value = yield* local.get(key)
      if (!value) throw new Error("Local resource disappeared during migration")
      const existing = yield* remote.get(key)
      if (
        existing &&
        !isDeepStrictEqual(encodeState(existing), encodeState(value))
      ) {
        throw new Error(`Remote resource conflicts with local state: ${fqn}`)
      }
      entries.push({ ...key, value })
    }
    const output = yield* local.getOutput(target)
    const remoteOutput = yield* remote.getOutput(target)
    if (output === undefined) throw new Error("Local stack output is missing")
    if (
      remoteOutput !== undefined &&
      !isDeepStrictEqual(encodeState(output), encodeState(remoteOutput))
    ) {
      throw new Error("Remote stack output conflicts with local state")
    }
    if (apply) {
      for (const entry of entries) yield* remote.set(entry)
      yield* remote.setOutput({ ...target, value: output })
      for (const entry of entries) {
        if (
          !isDeepStrictEqual(
            encodeState(yield* remote.get(entry)),
            encodeState(entry.value)
          )
        ) {
          throw new Error(`Migration verification failed: ${entry.fqn}`)
        }
      }
    }
    console.log(
      `${apply ? "Migrated and verified" : "Ready to migrate"} ${entries.length} production state records. Local backup retained.`
    )
  }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))
  )
)
