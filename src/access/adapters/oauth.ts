import { Effect } from "effect"
import { AsyncLocalStorage } from "node:async_hooks"
import { DurableObjectOAuthClientProvider } from "agents/mcp/do-oauth-client-provider"
import type { ConnectionLedger } from "../connection-ledger"

export class ConnectionOAuthProvider extends DurableObjectOAuthClientProvider {
  private generation: Promise<number | undefined> = Promise.resolve(undefined)
  private readonly cleanup: AsyncLocalStorage<boolean>
  constructor(
    storage: DurableObjectStorage,
    private readonly connections: Pick<ConnectionLedger, "get">,
    callbackUrl: string
  ) {
    const cleanup = new AsyncLocalStorage<boolean>()
    const guarded = new Proxy(storage, {
      get(target, property) {
        const value = Reflect.get(target, property, target)
        if (typeof value !== "function") return value
        return async (...args: unknown[]) => {
          if (
            !cleanup.getStore() &&
            ["get", "put", "delete", "list"].includes(String(property))
          )
            await current()
          return Reflect.apply(value, target, args)
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
      if (!record?.active || record.revision !== generation)
        throw new Error(
          "This connection changed. Reconnect before authorizing it."
        )
    }
  }
  override set serverId(id: string) {
    super.serverId = id
    this.generation = Effect.runPromise(this.connections.get(id)).then(
      (record) => record?.revision
    )
  }
  override get serverId() {
    return super.serverId
  }
  override clearServerStorage() {
    return this.cleanup.run(true, () => super.clearServerStorage())
  }
}
