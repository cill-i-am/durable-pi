import { Effect, Schema } from "effect"
import {
  COMMAND_TIMEOUT,
  CommandInput,
  MAX_CHECKPOINT,
  MAX_OUTPUT,
  TerminalFailure,
  type Checkpoint,
  type CommandRun,
} from "./contracts"
import type { TerminalStore } from "./adapters/sqlite"

export interface TerminalRuntime {
  restore: (bytes: Uint8Array | null, signal: AbortSignal) => Promise<void>
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
/** Owns command admission and durable results. Runtime teardown includes every descendant process. */
export class Terminal {
  private recovery: Promise<void> | null = null
  private cleanupError: string | null = null
  private active: {
    id: string
    controller: AbortController
    completion: Promise<void>
  } | null = null
  constructor(
    readonly repository: TerminalStore,
    private readonly runtime: TerminalRuntime,
    private readonly backups: CheckpointStorage
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
      runs: this.repository.list(),
      savedAt: this.repository.checkpoint()?.savedAt ?? null,
      busy: !!this.active || !!this.recovery,
      cleanupError: this.cleanupError,
    }
  }
  start(input: CommandInput) {
    return Effect.try({
      try: () => {
        const decoded = Schema.decodeUnknownSync(CommandInput)(input)
        const existing = this.repository.get(decoded.id)
        if (!existing && (this.active || this.recovery || this.cleanupError))
          throw new TerminalFailure({
            message: "Wait for the active command and its cleanup to finish.",
          })
        const run = this.repository.admit(decoded)
        if (existing || run.status !== "running")
          return {
            run,
            completion:
              this.active?.id === run.id
                ? this.active.completion
                : Promise.resolve(),
          }
        const controller = new AbortController()
        const completion = this.perform(run, controller).finally(() => {
          this.active = null
        })
        this.active = { id: run.id, controller, completion }
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
  private async perform(run: CommandRun, controller: AbortController) {
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
    // Includes cold start, restore, execution and checkpoint; no phase may extend the deadline.
    const timer = setTimeout(() => controller.abort(), COMMAND_TIMEOUT)
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
      await this.runtime.restore(bytes, controller.signal)
      live()
      const exitCode = await this.runtime.execute(
        run.command,
        append,
        controller.signal
      )
      live()
      const snapshot = await this.runtime.snapshot(controller.signal)
      live()
      if (snapshot.length > MAX_CHECKPOINT) throw new Error("Checkpoint limit")
      const saved = await this.backups.write(snapshot)
      live()
      return { exitCode, saved }
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
          checkpoint.saved
        )
    } catch {
      controller.abort()
      flush()
      this.repository.finish(run.id, {
        status: "failed",
        exitCode: null,
        error:
          "The command could not finish or save its workspace within the time/output limit. Inspect its output before starting another command. Recovery uses the last saved checkpoint.",
      })
    } finally {
      clearTimeout(timer)
      controller.signal.removeEventListener("abort", stop)
      // Retain admission ownership until a cancelled SDK call settles. A late cold
      // start must be torn down before another command can enter this container.
      await work.catch(() => {})
      // A cancelled command can leave children behind. Only container teardown is a hard stop.
      try {
        await this.runtime.close()
      } catch {
        this.cleanupError =
          "Container cleanup could not be confirmed. Retry cleanup before running another command."
      }
    }
  }
}
