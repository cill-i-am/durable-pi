import { startNativeContainer } from "./native-process"

export interface CapacityLease {
  owner: string
  epoch: number
  issuedAt: number
}
export interface NativeCapacityRPC extends Rpc.DurableObjectBranded {
  acquire: (owner: string) => Promise<CapacityLease>
  release: (owner: string, epoch: number) => boolean
  status: () => { used: number; maximum: number }
}
export interface CapacityState {
  next: number
  leases: CapacityLease[]
}
export interface CapacityStorage {
  get: () => CapacityState | undefined
  put: (state: CapacityState) => void
  atomic: <T>(body: () => T) => T
}

/** A slot is never freed by a deadline alone: its owner must confirm teardown. */
export class TerminalCapacityPool {
  constructor(
    private readonly storage: CapacityStorage,
    private readonly retire: (lease: CapacityLease) => Promise<boolean>,
    private readonly now = Date.now
  ) {}
  private allocate(owner: string) {
    return this.storage.atomic(() => {
      const state = this.storage.get() ?? { next: 1, leases: [] }
      const existing = state.leases.find((lease) => lease.owner === owner)
      if (existing) return existing
      if (state.leases.length >= 4) return null
      if (!Number.isSafeInteger(state.next + 1))
        throw new Error("Terminal capacity epoch exhausted")
      const lease = { owner, epoch: state.next, issuedAt: this.now() }
      this.storage.put({
        next: state.next + 1,
        leases: [...state.leases, lease],
      })
      return lease
    })
  }
  async acquire(owner: string): Promise<CapacityLease> {
    if (!/^[a-f0-9]{64}$/.test(owner))
      throw new Error("Invalid terminal capacity owner")
    const granted = this.allocate(owner)
    if (granted) return granted
    const candidates = this.storage.get()?.leases ?? []
    for (const lease of candidates) {
      if (this.now() - lease.issuedAt < 60000) continue
      if (!(await this.retire(lease))) continue
      this.release(lease.owner, lease.epoch)
      const reclaimed = this.allocate(owner)
      if (reclaimed) return reclaimed
    }
    throw new Error("All terminal slots are busy")
  }
  release(owner: string, epoch: number) {
    return this.storage.atomic(() => {
      const state = this.storage.get()
      if (
        !state?.leases.some(
          (lease) => lease.owner === owner && lease.epoch === epoch
        )
      )
        return false
      this.storage.put({
        ...state,
        leases: state.leases.filter(
          (lease) => lease.owner !== owner || lease.epoch !== epoch
        ),
      })
      return true
    })
  }
  status() {
    return { used: this.storage.get()?.leases.length ?? 0, maximum: 4 }
  }
}

export interface CapacityOwnerStorage {
  token: () => number | undefined
  setToken: (epoch: number | undefined) => void
  fence: () => number
  setFence: (epoch: number) => void
}
export interface CapacityBinding {
  acquire: (owner: string) => Promise<CapacityLease>
  release: (owner: string, epoch: number) => Promise<boolean>
}

/** Persist the capability before starting. Reclamation fences late starts. */
export class NativeContainerOwner {
  constructor(
    private readonly owner: string,
    private readonly container: Pick<
      Container,
      "start" | "images" | "setInactivityTimeout" | "destroy" | "running"
    >,
    private readonly capacity: CapacityBinding,
    private readonly storage: CapacityOwnerStorage
  ) {}
  async start(unrestricted = false, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const lease = await this.capacity.acquire(this.owner)
    if (
      lease.owner !== this.owner ||
      !Number.isSafeInteger(lease.epoch) ||
      lease.epoch < 1
    )
      throw new Error("Invalid terminal capacity lease")
    this.storage.setToken(lease.epoch)
    signal?.throwIfAborted()
    if (lease.epoch <= this.storage.fence())
      throw new Error("Terminal capacity lease was retired")
    await startNativeContainer(this.container, unrestricted)
  }
  async close() {
    const token = this.storage.token()
    await this.container.destroy()
    if (this.container.running)
      throw new Error("Terminal container teardown is unconfirmed")
    if (token !== undefined) {
      await this.capacity.release(this.owner, token)
      if (this.storage.token() === token) this.storage.setToken(undefined)
    }
  }
  async retireIdle(epoch: number) {
    if (!Number.isSafeInteger(epoch) || epoch < 1)
      throw new Error("Invalid terminal capacity epoch")
    const current = this.storage.token()
    if (current !== undefined && current !== epoch) return false
    if (this.container.running) return false
    this.storage.setFence(Math.max(this.storage.fence(), epoch))
    await this.container.destroy()
    return !this.container.running
  }
}
