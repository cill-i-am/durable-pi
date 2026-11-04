import { AsyncLocalStorage } from "node:async_hooks"

import { DurableObjectOAuthClientProvider } from "agents/mcp/do-oauth-client-provider"
import { Effect } from "effect"

import type { ConnectionLedger } from "../connection-ledger"
import {
  initialOAuthBinding,
  advanceOAuthBinding,
} from "../oauth-binding.machine"

export class ConnectionOAuthProvider extends DurableObjectOAuthClientProvider {
  private generation: Promise<number | undefined> = Promise.resolve(undefined)
  private binding = initialOAuthBinding()
  private readonly cleanup: AsyncLocalStorage<boolean>
  constructor(
    storage: DurableObjectStorage,
    private readonly connections: Pick<ConnectionLedger, "get">,
    callbackUrl: string
  ) {
    const cleanup = new AsyncLocalStorage<boolean>()
    const guarded = new Proxy(storage, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target)
        if (typeof value !== "function") return value
        return async (...args: unknown[]) => {
          if (
            !cleanup.getStore() &&
            ["get", "put", "delete", "list"].includes(String(property))
          )
            await current()
          return Reflect.apply(value, target, args) as unknown
        }
      },
    })
    super(guarded, "Durable Pi", callbackUrl)
    this.cleanup = cleanup
    const current = async () => {
      const generation = await this.generation
      const record = await Effect.runPromise(
        this.connections.get(this.serverId)
      )
      if (
        !this.binding.can({
          type: "USE",
          active: record?.active === true,
          revision: record?.revision,
        }) ||
        this.binding.context.revision !== generation
      )
        throw new Error(
          "This connection changed. Reconnect before authorizing it."
        )
    }
  }
  override set serverId(id: string) {
    const next = advanceOAuthBinding(this.binding, { type: "BIND", id })
    if (next === this.binding) return
    super.serverId = id
    this.binding = next
    this.generation = Effect.runPromise(this.connections.get(id)).then(
      (record) => {
        this.binding = advanceOAuthBinding(this.binding, {
          type: "RESOLVED",
          revision: record?.revision,
        })
        return this.binding.context.revision
      },
      (cause) => {
        this.binding = advanceOAuthBinding(this.binding, { type: "FAILED" })
        throw cause
      }
    )
  }
  override get serverId() {
    return super.serverId
  }
  private pendingGeneration() {
    if (this.binding.context.revision === undefined)
      throw new Error("The OAuth connection generation is unavailable")
    return `generation-${this.binding.context.revision}`
  }
  // Existing SDK pending-state/verifier keys acquire a revision namespace.
  // Credential/client/discovery keys and the public nonce.serverId stay intact.
  override stateKey(nonce: string) {
    return `${super.stateKey(this.pendingGeneration())}/${nonce}`
  }
  override codeVerifierKey(clientId: string) {
    return `${super.codeVerifierKey(clientId)}/${this.pendingGeneration()}`
  }
  override stateCodeVerifierPrefix(clientId: string) {
    return `${super.stateCodeVerifierPrefix(clientId)}${this.pendingGeneration()}/`
  }
  override challengeCodeVerifierPrefix(clientId: string) {
    return `${super.challengeCodeVerifierPrefix(clientId)}${this.pendingGeneration()}/`
  }
  override async state() {
    await this.generation
    return super.state()
  }
  override async checkState(state: string) {
    await this.generation
    return super.checkState(state)
  }
  override async consumeState(state: string) {
    await this.generation
    return super.consumeState(state)
  }
  override async saveCodeVerifier(verifier: string) {
    await this.generation
    return super.saveCodeVerifier(verifier)
  }
  override async codeVerifier() {
    await this.generation
    return super.codeVerifier()
  }
  override async codeVerifierKeys(
    clientId: string,
    options?: { includeChallengeKeys?: boolean }
  ) {
    await this.generation
    return super.codeVerifierKeys(clientId, options)
  }
  override async redirectToAuthorization(url: URL) {
    await this.generation
    return super.redirectToAuthorization(url)
  }
  async callbackRevision(state: string) {
    const checked = await this.checkState(state)
    return checked.valid && checked.serverId === this.serverId
      ? this.binding.context.revision
      : undefined
  }
  override clearServerStorage() {
    return this.cleanup.run(true, () => super.clearServerStorage())
  }
}
