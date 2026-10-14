import { Effect, Schema } from "effect"
import {
  COMMAND_TIMEOUT,
  CommandInput,
  MAX_CHECKPOINT,
  MAX_OUTPUT,
  TerminalFailure,
  TerminalNetworkPolicy,
  type Checkpoint,
  type CommandRun,
} from "./contracts"
import { InteractiveSession, type InteractiveRuntime } from "./session"
import { TransferPlan, MAX_TRANSFER_BYTES, fileDigest } from "./transfers"
import type { TerminalStore } from "./adapters/sqlite"

export interface TerminalRuntime {
  importFile?: (
    path: string,
    bytes: Uint8Array,
    signal: AbortSignal
  ) => Promise<void>
  exportFile?: (path: string, signal: AbortSignal) => Promise<Uint8Array>
  openInteractive?: (signal: AbortSignal) => Promise<InteractiveRuntime>
  restore: (
    bytes: Uint8Array | null,
    signal: AbortSignal,
    unrestricted?: boolean
  ) => Promise<void>
  execute: (
    command: string,
    output: (text: string) => void,
    signal: AbortSignal
  ) => Promise<number>
  snapshot: (signal: AbortSignal) => Promise<Uint8Array>
  close: () => Promise<void>
}
export interface CheckpointStorage {
  read: (checkpoint: Checkpoint) => Promise<Uint8Array>
  write: (bytes: Uint8Array) => Promise<Checkpoint>
}
export class Terminal {
  private recovery: Promise<void> | null = null
  private cleanupError: string | null = null
  private active: {
    id: string
    controller: AbortController
    completion: Promise<void>
    session?: InteractiveSession
  } | null = null
  constructor(
    readonly repository: TerminalStore,
    private readonly runtime: TerminalRuntime,
    private readonly backups: CheckpointStorage,
    private readonly exports?: CheckpointStorage
  ) {}
  configure(
    revision: number,
    active: boolean,
    revokeThrough = active ? -1 : revision
  ) {
    this.repository.configure(revision, active, revokeThrough)
    if (
      this.active &&
      !this.repository.authorized(this.repository.get(this.active.id)!)
    ) {
      this.repository.finish(this.active.id, {
        status: "cancelled",
        exitCode: null,
        error:
          "Bot archived. Workspace recovery uses the last saved checkpoint.",
      })
      this.active.controller.abort()
    }
  }
  recover() {
    if (this.recovery) return this.recovery
    if (this.active)
      throw new TerminalFailure({
        message: "Stop the active command before retrying cleanup.",
      })
    this.repository.recover()
    this.cleanupError = null
    this.recovery = this.runtime
      .close()
      .catch(() => {
        this.cleanupError =
          "Container cleanup could not be confirmed. Retry cleanup before running another command."
      })
      .finally(() => {
        this.recovery = null
      })
    return this.recovery
  }
  state() {
    return {
      networkPolicy: this.repository.networkPolicy(),
      runs: this.repository.list(),
      savedAt: this.repository.checkpoint()?.savedAt ?? null,
      busy: !!this.active || !!this.recovery,
      cleanupError: this.cleanupError,
      session: this.active?.session?.state() ?? null,
    }
  }
  configureNetwork(input: TerminalNetworkPolicy) {
    if (this.active || this.recovery || this.cleanupError)
      throw new TerminalFailure({
        message:
          "Stop or save the active terminal session and wait for cleanup before changing internet access.",
      })
    this.repository.configureNetwork(
      Schema.decodeUnknownSync(TerminalNetworkPolicy)(input)
    )
    return this.state()
  }
  startTransfer(id: string, transfer: TransferPlan, bytes?: Uint8Array) {
    return Effect.gen({ self: this }, function* () {
      const plan = yield* Effect.try(() =>
        Schema.decodeUnknownSync(TransferPlan)(transfer)
      )
      if (plan.kind === "import") {
        if (
          !bytes?.length ||
          bytes.length > MAX_TRANSFER_BYTES ||
          (yield* Effect.promise(() => fileDigest(bytes))) !== plan.sha256
        )
          return yield* new TerminalFailure({
            message: "The file bytes do not match this transfer.",
          })
      }
      return yield* this.start(
        {
          id,
          command: `${plan.kind === "import" ? "Import" : "Export"} ${plan.path}`,
        },
        plan.kind,
        { plan, bytes }
      )
    })
  }
  async exportedFile(id: string) {
    const record = this.repository.exported(id)
    if (
      !record ||
      !this.exports ||
      this.repository.get(id)?.status !== "succeeded"
    )
      throw new TerminalFailure({ message: "The exported file is not ready." })
    return this.exports.read(record)
  }
  startSession(id: string) {
    return this.start({ id, command: "Interactive terminal" }, "session")
  }
  session(id: string) {
    const session = this.active?.session
    if (!session || session.id !== id)
      throw new TerminalFailure({ message: "This terminal session has ended." })
    return session
  }
  start(
    input: CommandInput,
    kind: NonNullable<CommandRun["kind"]> = "command",
    transfer?: { plan: TransferPlan; bytes?: Uint8Array }
  ) {
    return Effect.try({
      try: () => {
        const decoded = Schema.decodeUnknownSync(CommandInput)(input)
        const existing = this.repository.get(decoded.id)
        if (!existing && (this.active || this.recovery || this.cleanupError))
          throw new TerminalFailure({
            message: "Wait for the active command and its cleanup to finish.",
          })
        const run = this.repository.admit(decoded, kind, transfer?.plan)
        if (existing || run.status !== "running")
          return {
            run,
            completion:
              this.active?.id === run.id
                ? this.active.completion
                : Promise.resolve(),
          }
        const controller = new AbortController()
        const session =
          kind === "session"
            ? new InteractiveSession(run.id, controller)
            : undefined
        const completion = this.perform(
          run,
          controller,
          session,
          transfer?.bytes
        ).finally(() => {
          this.active = null
        })
        this.active = { id: run.id, controller, completion, session }
        return { run, completion }
      },
      catch: (cause) =>
        cause instanceof TerminalFailure
          ? cause
          : new TerminalFailure({ message: "Invalid command request." }),
    })
  }
  cancel(id: string) {
    return Effect.try({
      try: () => {
        Schema.decodeUnknownSync(CommandInput.fields.id)(id)
        const run = this.repository.cancel(id)
        if (this.active?.id === id) this.active.controller.abort()
        return run
      },
      catch: (cause) =>
        cause instanceof TerminalFailure
          ? cause
          : new TerminalFailure({ message: "Could not cancel command." }),
    })
  }
  private async perform(
    run: CommandRun,
    controller: AbortController,
    session?: InteractiveSession,
    inputBytes?: Uint8Array
  ) {
    await Promise.resolve()
    let output = "",
      lastFlush = 0
    const flush = () => {
      this.repository.progress(run.id, output)
      lastFlush = Date.now()
    }
    const append = (text: string) => {
      if (controller.signal.aborted) throw new Error("Stopped")
      output += text.slice(0, MAX_OUTPUT - output.length)
      if (Date.now() - lastFlush > 250) flush()
      if (output.length >= MAX_OUTPUT) throw new Error("Output limit")
    }
    let timer = setTimeout(() => controller.abort(), COMMAND_TIMEOUT)
    let stop!: () => void
    const live = () => {
      if (controller.signal.aborted) throw new Error("Stopped")
    }
    const stopped = new Promise<never>((_, reject) => {
      stop = () => {
        reject(new Error("Stopped or timed out"))
        void this.runtime.close().catch(() => {})
      }
      controller.signal.addEventListener("abort", stop, { once: true })
      if (controller.signal.aborted) stop()
    })
    const work = (async () => {
      live()
      await this.runtime.close()
      live()
      const previous = this.repository.checkpoint()
      const bytes = previous ? await this.backups.read(previous) : null
      live()
      if (bytes && bytes.length > MAX_CHECKPOINT)
        throw new Error("Checkpoint limit")
      await this.runtime.restore(
        bytes,
        controller.signal,
        run.networkUnrestricted ?? false
      )
      live()
      let exitCode = 0
      if (run.transfer?.kind === "import") {
        if (!this.runtime.importFile || !inputBytes)
          throw new Error("Import unavailable")
        await this.runtime.importFile(
          run.transfer.path,
          inputBytes,
          controller.signal
        )
      } else if (run.transfer?.kind === "export") {
        if (!this.runtime.exportFile || !this.exports)
          throw new Error("Export unavailable")
        const fileBytes = await this.runtime.exportFile(
          run.transfer.path,
          controller.signal
        )
        live()
        if (!fileBytes.length || fileBytes.length > MAX_TRANSFER_BYTES)
          throw new Error("File size")
        const exported = await this.exports.write(fileBytes)
        live()
        return { exitCode: 0, saved: undefined, exported }
      } else if (session) {
        if (!this.runtime.openInteractive)
          throw new Error("Interactive runtime unavailable")
        session.ready(await this.runtime.openInteractive(controller.signal))
        clearTimeout(timer)
        timer = setTimeout(
          () => controller.abort(),
          Math.max(0, session.maximumAt - Date.now())
        )
        await session.completion
        live()
        clearTimeout(timer)
        timer = setTimeout(() => controller.abort(), 10000)
        await session.settleConnections()
        live()
        await session.closeRuntime()
        live()
      } else {
        exitCode = await this.runtime.execute(
          run.command,
          append,
          controller.signal
        )
      }
      live()
      const snapshot = await this.runtime.snapshot(controller.signal)
      live()
      if (snapshot.length > MAX_CHECKPOINT) throw new Error("Checkpoint limit")
      const saved = await this.backups.write(snapshot)
      live()
      return { exitCode, saved, exported: undefined }
    })()
    try {
      const checkpoint = await Promise.race([work, stopped])
      flush()
      if (!controller.signal.aborted)
        this.repository.finish(
          run.id,
          {
            status: checkpoint.exitCode === 0 ? "succeeded" : "failed",
            exitCode: checkpoint.exitCode,
            error: null,
          },
          checkpoint.saved,
          checkpoint.exported
        )
    } catch {
      controller.abort()
      flush()
      this.repository.finish(run.id, {
        status: "failed",
        exitCode: null,
        error: run.transfer
          ? "The file transfer could not finish. Use a regular file inside /workspace, up to 8 MB. The previous checkpoint is unchanged."
          : session
            ? "The terminal session ended or could not save. Recovery uses the last saved checkpoint."
            : "The command could not finish or save its workspace within the time/output limit. Inspect its output before starting another command. Recovery uses the last saved checkpoint.",
      })
    } finally {
      clearTimeout(timer)
      session?.dispose()
      controller.signal.removeEventListener("abort", stop)
      await work.catch(() => {})
      await session?.settleConnections()
      try {
        await this.runtime.close()
      } catch {
        this.cleanupError =
          "Container cleanup could not be confirmed. Retry cleanup before running another command."
      }
    }
  }
}
