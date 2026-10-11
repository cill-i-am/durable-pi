import { AsyncLocalStorage } from "node:async_hooks"
import { DurableObjectOAuthClientProvider } from "agents/mcp/do-oauth-client-provider"
import type { ConnectionStore } from "./connections"

/** Fence SDK work admitted before disconnect from restoring or deleting newer credentials. */
export class ConnectionOAuthProvider extends DurableObjectOAuthClientProvider {
  private generation: number | undefined
  private readonly cleanup: AsyncLocalStorage<boolean>
  constructor(
    storage: DurableObjectStorage,
    private readonly connections: ConnectionStore,
    callbackUrl: string
  ) {
    const cleanup = new AsyncLocalStorage<boolean>()
    const guarded = new Proxy(storage, {
      get(target, property) {
        const value = Reflect.get(target, property, target)
        if (typeof value !== "function") return value
        return (...args: unknown[]) => {
          if (
            !cleanup.getStore() &&
            ["get", "put", "delete", "list"].includes(String(property))
          )
            current()
          return Reflect.apply(value, target, args)
        }
      },
    })
    super(guarded, "Durable Pi", callbackUrl)
    this.cleanup = cleanup
    const current = () => {
      const record = this.connections.get(this.serverId)
      if (!record?.active || record.revision !== this.generation)
        throw new Error(
          "This connection changed. Reconnect before authorizing it."
        )
    }
  }
  override set serverId(id: string) {
    super.serverId = id
    this.generation = this.connections.get(id)?.revision
  }
  override get serverId() {
    return super.serverId
  }
  override clearServerStorage() {
    // Only the manager's explicit removeServer path owns credential cleanup.
    return this.cleanup.run(true, () => super.clearServerStorage())
  }
}
