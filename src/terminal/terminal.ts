import { preserveFatal, observeCleanup } from "../shared/effect"
import {
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Layer,
  Option,
  Schema,
} from "effect"
import {
  COMMAND_TIMEOUT,
  CommandInput,
  MAX_CHECKPOINT,
  MAX_OUTPUT,
  TerminalFailure,
  TerminalStorageError,
  TerminalNetworkPolicy,
  type CommandRun,
  type TerminalState,
} from "./contracts"
import {
  InteractiveSession,
  type TerminalRelay,
  type TerminalSession,
} from "./session"
import {
  ImportFile,
  TransferPlan,
  MAX_TRANSFER_BYTES,
  planImport,
} from "./transfers"
import type { TerminalLedger } from "./repository"
import type {
  CheckpointStorage,
  TerminalRuntime,
  TerminalRuntimeError,
} from "./runtime"

export type { TerminalRuntime, CheckpointStorage } from "./runtime"
export interface TerminalOptions {
  repository: TerminalLedger
  runtime: TerminalRuntime
  backups: CheckpointStorage
  exports?: CheckpointStorage
  relay: TerminalRelay
  digest: (bytes: Uint8Array) => Effect.Effect<string, TerminalRuntimeError>
}
export interface StartedCommand {
  run: CommandRun
  completion: Effect.Effect<void, TerminalOperationError>
}
export type TerminalOperationError =
  TerminalFailure | TerminalStorageError | TerminalRuntimeError
export type TerminalSnapshot = TerminalState & {
  readonly networkPolicy: TerminalNetworkPolicy
}
export interface TerminalOperations {
  get: (
    id: string
  ) => Effect.Effect<CommandRun | undefined, TerminalOperationError>
  state: () => Effect.Effect<TerminalSnapshot, TerminalOperationError>
  configure: (
    revision: number,
    active: boolean,
    revokeThrough?: number
  ) => Effect.Effect<void, TerminalOperationError>
  configureNetwork: (
    input: TerminalNetworkPolicy
  ) => Effect.Effect<TerminalSnapshot, TerminalOperationError>
  recover: () => Effect.Effect<void, TerminalOperationError>
  start: (
    input: CommandInput,
    kind?: NonNullable<CommandRun["kind"]>,
    transfer?: { plan: TransferPlan; bytes?: Uint8Array }
  ) => Effect.Effect<StartedCommand, TerminalOperationError>
  startTransfer: (
    id: string,
    transfer: TransferPlan,
    bytes?: Uint8Array
  ) => Effect.Effect<StartedCommand, TerminalOperationError>
  startImport: (
    input: typeof ImportFile.Type,
    bytes: Uint8Array
  ) => Effect.Effect<StartedCommand, TerminalOperationError>
  startSession: (
    id: string
  ) => Effect.Effect<StartedCommand, TerminalOperationError>
  session: (
    id: string
  ) => Effect.Effect<TerminalSession, TerminalOperationError>
  cancel: (
    id: string
  ) => Effect.Effect<CommandRun | null, TerminalOperationError>
  exportedFile: (
    id: string
  ) => Effect.Effect<Uint8Array, TerminalOperationError>
}
const expected = Schema.decodeUnknownOption(
  Schema.Union([TerminalFailure, TerminalStorageError])
)
const attempt = <T>(body: () => T) =>
  Effect.try({
    try: body,
    catch: (cause) => {
      const error = expected(cause)
      if (Option.isSome(error)) return error.value
      throw cause
    },
  })
const cleanupMessage =
  "Container cleanup could not be confirmed. Retry cleanup before running another command."

export class Terminal implements TerminalOperations {
  private closed = false
  private recovery: Fiber.Fiber<void, TerminalOperationError> | null = null
  private cleanupError: string | null = null
  private active: {
    id: string
    controller: AbortController
    fiber: Fiber.Fiber<void, TerminalOperationError>
    session?: InteractiveSession
  } | null = null
  constructor(
    private readonly options: TerminalOptions,
    private readonly tasks: FiberSet.FiberSet<void, TerminalOperationError>,
    private readonly clock: Clock.Clock
  ) {}
  private get repository() {
    return this.options.repository
  }
  shutdown = Effect.fn("Terminal.shutdown")(() =>
    Effect.sync(() => {
      this.closed = true
    }).pipe(Effect.andThen(FiberSet.clear(this.tasks)))
  )
  get = Effect.fn("Terminal.get")((id: string) => this.repository.get(id))
  configure = Effect.fn("Terminal.configure")(
    (
      revision: number,
      active: boolean,
      revokeThrough = active ? -1 : revision
    ) =>
      Effect.gen({ self: this }, function* () {
        yield* this.repository.configure(revision, active, revokeThrough)
        const pending = this.active
        if (pending) {
          const run = yield* this.repository.get(pending.id)
          if (run && !(yield* this.repository.authorized(run))) {
            yield* this.repository.finish(pending.id, {
              status: "cancelled",
              exitCode: null,
              error:
                "Bot archived. Workspace recovery uses the last saved checkpoint.",
            })
            pending.controller.abort()
          }
        }
      })
  )
  state = Effect.fn("Terminal.state")(() =>
    Effect.gen({ self: this }, function* () {
      const networkPolicy = yield* this.repository.networkPolicy()
      const runs = yield* this.repository.list()
      const checkpoint = yield* this.repository.checkpoint()
      return {
        networkPolicy,
        runs,
        savedAt: checkpoint?.savedAt ?? null,
        busy: !!this.active || !!this.recovery,
        cleanupError: this.cleanupError,
        session: this.active?.session?.state() ?? null,
      }
    })
  )
  configureNetwork = Effect.fn("Terminal.configureNetwork")(
    (input: TerminalNetworkPolicy) =>
      Effect.gen({ self: this }, function* () {
        yield* attempt(() => {
          if (this.active || this.recovery || this.cleanupError)
            throw new TerminalFailure({
              message:
                "Stop or save the active terminal session and wait for cleanup before changing internet access.",
            })
        })
        yield* this.repository.configureNetwork(
          Schema.decodeUnknownSync(TerminalNetworkPolicy)(input)
        )
        return yield* this.state()
      })
  )
  recover = Effect.fn("Terminal.recover")(() =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen({ self: this }, function* () {
        if (this.recovery) return yield* restore(Fiber.join(this.recovery))
        yield* attempt(() => {
          if (this.closed)
            throw new TerminalFailure({
              message: "The terminal host has stopped.",
            })
          if (this.active)
            throw new TerminalFailure({
              message: "Stop the active command before retrying cleanup.",
            })
        })
        yield* this.repository.recover()
        this.cleanupError = null
        const begin = yield* Deferred.make<void>()
        const work = Deferred.await(begin).pipe(
          Effect.andThen(this.options.runtime.close()),
          preserveFatal,
          Effect.catchTag("TerminalRuntimeError", () =>
            Effect.sync(() => {
              this.cleanupError = cleanupMessage
            })
          ),
          Effect.ensuring(this.options.runtime.settle()),
          Effect.ensuring(
            Effect.sync(() => {
              this.recovery = null
            })
          )
        )
        this.recovery = yield* FiberSet.run(
          this.tasks,
          Effect.interruptible(work)
        )
        const fiber = this.recovery
        yield* Deferred.succeed(begin, undefined)
        return yield* restore(Fiber.join(fiber))
      })
    )
  )
  startTransfer = Effect.fn("Terminal.startTransfer")(
    (id: string, transfer: TransferPlan, bytes?: Uint8Array) =>
      Effect.gen({ self: this }, function* () {
        const plan = yield* Schema.decodeUnknownEffect(TransferPlan)(
          transfer
        ).pipe(
          Effect.mapError(
            () => new TerminalFailure({ message: "Invalid file transfer." })
          )
        )
        if (
          plan.kind === "import" &&
          (!bytes?.length ||
            bytes.length > MAX_TRANSFER_BYTES ||
            (yield* this.options.digest(bytes)) !== plan.sha256)
        )
          return yield* new TerminalFailure({
            message: "The file bytes do not match this transfer.",
          })
        return yield* this.start(
          {
            id,
            command: `${plan.kind === "import" ? "Import" : "Export"} ${plan.path}`,
          },
          plan.kind,
          { plan, bytes }
        )
      })
  )
  startImport = Effect.fn("Terminal.startImport")(
    (input: typeof ImportFile.Type, bytes: Uint8Array) =>
      Effect.gen({ self: this }, function* () {
        const metadata = yield* Schema.decodeUnknownEffect(ImportFile)(
          input
        ).pipe(
          preserveFatal,
          Effect.mapError(
            () => new TerminalFailure({ message: "Invalid file transfer." })
          )
        )
        if (!bytes.length || bytes.length > MAX_TRANSFER_BYTES)
          return yield* new TerminalFailure({
            message: "Choose a non-empty file up to 8 MB.",
          })
        const payload = bytes.slice()
        const digest = yield* this.options.digest(payload)
        const plan = planImport(metadata, payload.length, digest)
        return yield* this.start(
          { id: metadata.id, command: `Import ${plan.path}` },
          "import",
          { plan, bytes: payload }
        )
      })
  )
  exportedFile = Effect.fn("Terminal.exportedFile")((id: string) =>
    Effect.gen({ self: this }, function* () {
      const record = yield* this.repository.exported(id)
      if (
        !record ||
        !this.options.exports ||
        (yield* this.repository.get(id))?.status !== "succeeded"
      )
        return yield* new TerminalFailure({
          message: "The exported file is not ready.",
        })
      return yield* this.options.exports
        .read(record)
        .pipe(Effect.ensuring(this.options.exports.settle()))
    })
  )
  startSession = (id: string) =>
    this.start({ id, command: "Interactive terminal" }, "session")
  session = Effect.fn("Terminal.session")((id: string) =>
    attempt(() => {
      const session = this.active?.session
      if (!session || session.id !== id)
        throw new TerminalFailure({
          message: "This terminal session has ended.",
        })
      return session
    })
  )
  start = Effect.fn("Terminal.start")(
    (
      input: CommandInput,
      kind: NonNullable<CommandRun["kind"]> = "command",
      transfer?: { plan: TransferPlan; bytes?: Uint8Array }
    ) =>
      Effect.uninterruptible(
        Effect.gen({ self: this }, function* () {
          const decoded = yield* Schema.decodeUnknownEffect(CommandInput)(
            input
          ).pipe(
            Effect.mapError(
              () => new TerminalFailure({ message: "Invalid command request." })
            )
          )
          if (this.closed)
            return yield* new TerminalFailure({
              message: "The terminal host has stopped.",
            })
          const existing = yield* this.repository.get(decoded.id)
          if (!existing && (this.active || this.recovery || this.cleanupError))
            return yield* new TerminalFailure({
              message: "Wait for the active command and its cleanup to finish.",
            })
          const run = yield* this.repository.admit(
            decoded,
            kind,
            transfer?.plan
          )
          if (existing || run.status !== "running")
            return {
              run,
              completion:
                this.active?.id === run.id
                  ? Fiber.join(this.active.fiber)
                  : Effect.void,
            }
          const controller = new AbortController()
          const session =
            kind === "session"
              ? new InteractiveSession(
                  run.id,
                  controller,
                  this.options.relay,
                  this.clock
                )
              : undefined
          const begin = yield* Deferred.make<void>()
          const work = Deferred.await(begin).pipe(
            Effect.andThen(
              this.perform(run, controller, session, transfer?.bytes)
            ),
            Effect.ensuring(
              Effect.sync(() => {
                controller.abort()
                session?.dispose()
                this.active = null
              })
            )
          )
          const fiber = yield* FiberSet.run(
            this.tasks,
            Effect.interruptible(work)
          )
          this.active = { id: run.id, controller, fiber, session }
          yield* Deferred.succeed(begin, undefined)
          return { run, completion: Fiber.join(fiber) }
        })
      )
  )
  cancel = Effect.fn("Terminal.cancel")((id: string) =>
    Effect.gen({ self: this }, function* () {
      Schema.decodeUnknownSync(CommandInput.fields.id)(id)
      const run = yield* this.repository.cancel(id)
      if (this.active?.id === id) this.active.controller.abort()
      return run
    })
  )
  private perform(
    run: CommandRun,
    controller: AbortController,
    session?: InteractiveSession,
    inputBytes?: Uint8Array
  ) {
    const { runtime, backups, exports: exportStorage } = this.options
    let output = "",
      publishedOutput = ""
    const now = () => this.clock.currentTimeMillisUnsafe()
    const flush = () =>
      Effect.suspend(() => {
        const next = output
        if (next === publishedOutput) return Effect.void
        return this.repository.progress(run.id, next).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              publishedOutput = next
            })
          )
        )
      })
    // Native stream callbacks only buffer. This owned Effect publishes progress;
    // its failure is raced with command work and joined before final publication.
    const publishOutput = Effect.forever(
      Effect.sleep(250).pipe(Effect.andThen(flush))
    )
    const live = () => {
      if (controller.signal.aborted)
        throw new TerminalFailure({ message: "Stopped or timed out" })
    }
    const append = (text: string) => {
      live()
      output += text.slice(0, MAX_OUTPUT - output.length)
      if (output.length >= MAX_OUTPUT)
        throw new TerminalFailure({ message: "Output limit" })
    }
    let deadline = now() + COMMAND_TIMEOUT,
      changed = Deferred.makeUnsafe<void>()
    const changeDeadline = (at: number) => {
      const previous = changed
      deadline = at
      changed = Deferred.makeUnsafe<void>()
      Deferred.doneUnsafe(previous, Effect.void)
    }
    const timer = Effect.gen(function* () {
      for (;;) {
        const change = changed
        const remaining = Math.max(
          0,
          deadline - (yield* Clock.currentTimeMillis)
        )
        const expired = yield* Effect.raceFirst(
          Effect.sleep(remaining).pipe(Effect.as(true)),
          Deferred.await(change).pipe(Effect.as(false))
        )
        if (expired) {
          controller.abort()
          return
        }
      }
    })
    const stopped = Effect.callback<never, TerminalFailure>((resume) => {
      const stop = () =>
        resume(
          Effect.fail(new TerminalFailure({ message: "Stopped or timed out" }))
        )
      controller.signal.addEventListener("abort", stop, { once: true })
      if (controller.signal.aborted) stop()
      return Effect.sync(() =>
        controller.signal.removeEventListener("abort", stop)
      )
    })
    const work = Effect.gen({ self: this }, function* () {
      yield* attempt(live)
      yield* runtime.close()
      yield* attempt(live)
      const previous = yield* this.repository.checkpoint()
      const bytes = previous ? yield* backups.read(previous) : null
      yield* attempt(() => {
        live()
        if (bytes && bytes.length > MAX_CHECKPOINT)
          throw new TerminalFailure({ message: "Checkpoint limit" })
      })
      yield* runtime.restore(
        bytes,
        controller.signal,
        run.networkUnrestricted ?? false
      )
      yield* attempt(live)
      let exitCode = 0
      if (run.transfer?.kind === "import") {
        if (!inputBytes)
          return yield* new TerminalFailure({ message: "Import unavailable" })
        yield* runtime.importFile(
          run.transfer.path,
          inputBytes,
          controller.signal
        )
      } else if (run.transfer?.kind === "export") {
        if (!exportStorage)
          return yield* new TerminalFailure({ message: "Export unavailable" })
        const exportedBytes = yield* runtime.exportFile(
          run.transfer.path,
          controller.signal
        )
        yield* attempt(() => {
          live()
          if (
            !exportedBytes.length ||
            exportedBytes.length > MAX_TRANSFER_BYTES
          )
            throw new TerminalFailure({ message: "File size" })
        })
        const exported = yield* exportStorage.write(exportedBytes)
        yield* attempt(live)
        return { exitCode: 0, saved: undefined, exported }
      } else if (session) {
        yield* session.ready(yield* runtime.openInteractive(controller.signal))
        changeDeadline(session.maximumAt)
        yield* session.completion
        yield* attempt(live)
        changeDeadline(now() + 10_000)
        yield* session.settleConnections()
        yield* attempt(live)
        yield* session.closeRuntime()
        yield* attempt(live)
      } else
        exitCode = yield* runtime.execute(
          run.command,
          append,
          controller.signal
        )
      yield* attempt(live)
      const snapshot = yield* runtime.snapshot(controller.signal)
      yield* attempt(() => {
        live()
        if (snapshot.length > MAX_CHECKPOINT)
          throw new TerminalFailure({ message: "Checkpoint limit" })
      })
      const saved = yield* backups.write(snapshot)
      yield* attempt(live)
      return { exitCode, saved, exported: undefined }
    })
    const failure = () =>
      Effect.gen({ self: this }, function* () {
        controller.abort()
        yield* flush()
        yield* this.repository.finish(run.id, {
          status: "failed",
          exitCode: null,
          error: run.transfer
            ? "The file transfer could not finish. Use a regular file inside /workspace, up to 8 MB. The previous checkpoint is unchanged."
            : session
              ? "The terminal session ended or could not save. Recovery uses the last saved checkpoint."
              : "The command could not finish or save its workspace within the time/output limit. Inspect its output before starting another command. Recovery uses the last saved checkpoint.",
        })
      })
    const close = () =>
      runtime.close().pipe(
        preserveFatal,
        Effect.catchTag("TerminalRuntimeError", () => Effect.void)
      )
    const finalizeClose = () =>
      runtime.close().pipe(
        preserveFatal,
        Effect.catchTag("TerminalRuntimeError", () =>
          Effect.sync(() => {
            this.cleanupError = cleanupMessage
          })
        )
      )
    return Effect.acquireUseRelease(
      Effect.void,
      () =>
        Effect.scoped(
          Effect.gen({ self: this }, function* () {
            yield* Effect.forkScoped(timer)
            if (session) yield* Effect.forkScoped(session.watchLease())
            const result = yield* observeCleanup(work, (observed) =>
              Effect.raceFirst(
                Effect.raceFirst(observed, stopped),
                publishOutput
              )
            )
            yield* attempt(live)
            yield* flush()
            yield* this.repository.finish(
              run.id,
              {
                status: result.exitCode === 0 ? "succeeded" : "failed",
                exitCode: result.exitCode,
                error: null,
              },
              result.saved,
              result.exported
            )
          })
        ).pipe(
          preserveFatal,
          Effect.catchTags({
            TerminalRuntimeError: () => failure().pipe(Effect.andThen(close())),
            TerminalFailure: () => failure().pipe(Effect.andThen(close())),
          })
        ),
      (_, exit) => {
        const recordFailure = Exit.isFailure(exit)
          ? failure().pipe(Effect.ensuring(close()))
          : Effect.void
        const release = Effect.gen(function* () {
          session?.dispose()
          yield* runtime.settle()
          yield* backups.settle()
          if (exportStorage) yield* exportStorage.settle()
          if (session) yield* session.settleConnections()
        }).pipe(Effect.ensuring(finalizeClose()))
        return recordFailure.pipe(Effect.ensuring(release))
      }
    ).pipe(
      Effect.provideService(Clock.Clock, this.clock),
      Effect.withSpan("Terminal.perform", {
        attributes: { "terminal.command_id": run.id },
      })
    )
  }
}
export class TerminalService extends Context.Service<
  TerminalService,
  TerminalOperations
>()("durable-pi/terminal/Terminal") {}
export const terminalLayer = (options: TerminalOptions) =>
  Layer.effect(
    TerminalService,
    Effect.gen(function* () {
      const terminal = new Terminal(
        options,
        yield* FiberSet.make<void, TerminalOperationError>(),
        yield* Clock.Clock
      )
      yield* Effect.addFinalizer(() => terminal.shutdown())
      return terminal
    })
  )
