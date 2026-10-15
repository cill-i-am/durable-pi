import { Effect, ManagedRuntime } from "effect"
import { afterEach } from "vitest"
import { TerminalService, terminalLayer } from "../src/terminal/terminal"
import type {
  CommandInput,
  CommandRun,
  TerminalNetworkPolicy,
} from "../src/terminal/contracts"
import type { TransferPlan } from "../src/terminal/transfers"
import type { TerminalLedger } from "../src/terminal/repository"
import type { TerminalRelay } from "../src/terminal/session"
import {
  effectTerminalRuntime,
  effectCheckpointStorage,
  terminalFileDigest,
  type ForeignTerminalRuntime,
  type ForeignCheckpointStorage,
} from "../src/terminal/adapters/interop"

export type { ForeignTerminalRuntime as TerminalRuntime } from "../src/terminal/adapters/interop"

const runtimes = new Set<
  ManagedRuntime.ManagedRuntime<TerminalService, never>
>()
afterEach(async () => {
  for (const runtime of runtimes) await runtime.dispose()
  runtimes.clear()
})

/** Foreign test boundary retains the old fixture ergonomics; application work
 * and all background jobs execute through the actual scoped service Layer. */
export class Terminal {
  readonly service: TerminalService["Service"]
  readonly runtime: ManagedRuntime.ManagedRuntime<TerminalService, never>
  constructor(
    readonly repository: TerminalLedger,
    runtime: ForeignTerminalRuntime,
    backups: ForeignCheckpointStorage,
    relay: TerminalRelay,
    exports?: ForeignCheckpointStorage
  ) {
    this.runtime = ManagedRuntime.make(
      terminalLayer({
        repository,
        runtime: effectTerminalRuntime(runtime),
        backups: effectCheckpointStorage(backups),
        exports: exports ? effectCheckpointStorage(exports) : undefined,
        relay,
        digest: terminalFileDigest,
      })
    )
    runtimes.add(this.runtime)
    this.service = this.runtime.runSync(TerminalService)
  }
  configure(revision: number, active: boolean, revokeThrough?: number) {
    return this.runtime.runSync(
      this.service.configure(revision, active, revokeThrough)
    )
  }
  state() {
    return this.runtime.runSync(this.service.state())
  }
  session(id: string) {
    return this.runtime.runSync(this.service.session(id))
  }
  configureNetwork(input: TerminalNetworkPolicy) {
    return this.runtime.runSync(this.service.configureNetwork(input))
  }
  recover() {
    return this.runtime.runPromise(this.service.recover())
  }
  exportedFile(id: string) {
    return this.runtime.runPromise(this.service.exportedFile(id))
  }
  start(
    input: CommandInput,
    kind?: NonNullable<CommandRun["kind"]>,
    transfer?: { plan: TransferPlan; bytes?: Uint8Array }
  ) {
    return this.service.start(input, kind, transfer).pipe(
      Effect.map((value) => ({
        run: value.run,
        completion: this.runtime.runPromise(value.completion),
      }))
    )
  }
  startSession(id: string) {
    return this.start({ id, command: "Interactive terminal" }, "session")
  }
  startTransfer(id: string, plan: TransferPlan, bytes?: Uint8Array) {
    return this.service.startTransfer(id, plan, bytes).pipe(
      Effect.map((value) => ({
        run: value.run,
        completion: this.runtime.runPromise(value.completion),
      }))
    )
  }
  cancel(id: string) {
    return this.service.cancel(id)
  }
}
