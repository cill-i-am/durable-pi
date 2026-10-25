import {
  createEffectActor,
  send,
  waitFor,
  type EffectActor,
} from "@xstate/effect"
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
  Scope,
  Semaphore,
} from "effect"

import { preserveFatal, observeCleanup, orDieAll } from "../shared/effect"
import type { CommandRecord } from "./command.machine"
import {
  COMMAND_TIMEOUT,
  CommandInput,
  MAX_CHECKPOINT,
  MAX_OUTPUT,
  TerminalFailure,
  TerminalStorageError,
  TerminalNetworkPolicy,
  CommandRun,
  type TerminalState,
} from "./contracts"
import { terminalDeadlineMachine } from "./deadline.machine"
import { executeTerminal } from "./execution"
import type { TerminalLedger } from "./repository"
import type {
  CheckpointStorage,
  TerminalRuntime,
  TerminalRuntimeError,
} from "./runtime"
import {
  terminalServiceHostMachine,
  terminalCleanupMessage as cleanupMessage,
  type HostCheck,
  type HostObservation,
  type HostPermission,
} from "./service-host.machine"
import {
  makeInteractiveSession,
  type InteractiveSession,
  type TerminalRelay,
  type TerminalSession,
} from "./session"
import {
  ImportFile,
  TransferPlan,
  MAX_TRANSFER_BYTES,
  planImport,
} from "./transfers"

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
  | TerminalFailure
  | TerminalStorageError
  | TerminalRuntimeError
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
const commandResult = Schema.decodeUnknownSync(CommandRun)

export class Terminal implements TerminalOperations {
  private readonly admissions = Semaphore.makeUnsafe(1)
  private recovery: Fiber.Fiber<void, TerminalOperationError> | null = null
  private active: {
    id: string
    attemptId: string
    authorityRevision: number
    controller: AbortController
    fiber: Fiber.Fiber<void, TerminalOperationError>
    session?: InteractiveSession
  } | null = null
  constructor(
    private readonly options: TerminalOptions,
    private readonly tasks: FiberSet.FiberSet<void, TerminalOperationError>,
    private readonly clock: Clock.Clock,
    private readonly host: EffectActor<typeof terminalServiceHostMachine>
  ) {}
  private get repository() {
    return this.options.repository
  }
  private observe = (type: HostObservation) =>
    Effect.gen({ self: this }, function* () {
      const ack = yield* Deferred.make<void>()
      yield* send(this.host, { type, ack })
      yield* Deferred.await(ack)
    })
  private check = (mode: HostCheck) =>
    Effect.gen({ self: this }, function* () {
      if (this.host.getSnapshot().status !== "active")
        return yield* new TerminalFailure({
          message: "The terminal host has stopped.",
        })
      const reply = yield* Deferred.make<HostPermission>()
      yield* send(this.host, {
        type: "CHECK",
        mode,
        active: this.active !== null,
        reply,
      })
      const permission = yield* Deferred.await(reply)
      if (permission === "stopped")
        return yield* new TerminalFailure({
          message: "The terminal host has stopped.",
        })
      if (permission === "active")
        return yield* new TerminalFailure({
          message: "Stop the active command before retrying cleanup.",
        })
      if (permission === "cleanup")
        return yield* new TerminalFailure({
          message: "Wait for the active command and its cleanup to finish.",
        })
      return permission
    })
  shutdown = Effect.fn("Terminal.shutdown")(() =>
    // CLOSE is enqueued before waiting for the installation lock. Subsequent
    // CHECK events cannot overtake it, including after an awaited SQL claim.
    this.observe("CLOSE").pipe(
      Effect.andThen(this.admissions.withPermit(FiberSet.clear(this.tasks)))
    )
  )
  get = Effect.fn("Terminal.get")((id: string) =>
    this.repository
      .get(id)
      .pipe(Effect.map((run) => (run ? commandResult(run) : undefined)))
  )
  configure = Effect.fn("Terminal.configure")(
    (
      revision: number,
      active: boolean,
      revokeThrough: number = active ? -1 : revision
    ) =>
      Effect.suspend(() => {
        let revoked: AbortController | undefined
        return Effect.gen({ self: this }, function* () {
          yield* this.repository.configure(
            revision,
            active,
            revokeThrough,
            (authority) => {
              const pending = this.active
              if (
                pending &&
                (!authority.active ||
                  pending.authorityRevision <= authority.revokedThrough)
              )
                revoked = pending.controller
            }
          )
          const pending = this.active
          if (pending) {
            const run = yield* this.repository.get(pending.id)
            if (run && !(yield* this.repository.authorized(run)))
              yield* this.repository.finish(
                pending.id,
                {
                  status: "cancelled",
                  exitCode: null,
                  error:
                    "Bot archived. Workspace recovery uses the last saved checkpoint.",
                },
                undefined,
                undefined,
                pending.attemptId
              )
          }
        }).pipe(Effect.ensuring(Effect.sync(() => revoked?.abort())))
      })
  )
  state = Effect.fn("Terminal.state")(() =>
    Effect.gen({ self: this }, function* () {
      const networkPolicy = yield* this.repository.networkPolicy()
      const runs = yield* this.repository.list()
      const checkpoint = yield* this.repository.checkpoint()
      const blocked = yield* this.repository.blocked()
      return {
        networkPolicy,
        runs,
        savedAt: checkpoint?.savedAt ?? null,
        busy:
          !!this.active ||
          this.host.getSnapshot().matches({ cleanup: "recovering" }) ||
          (!blocked && (yield* this.repository.occupied())),
        cleanupError:
          this.host.getSnapshot().context.cleanupError ??
          (blocked ? cleanupMessage : null),
        session: this.active?.session?.state() ?? null,
      }
    })
  )
  configureNetwork = Effect.fn("Terminal.configureNetwork")(
    (input: TerminalNetworkPolicy) =>
      Effect.gen({ self: this }, function* () {
        yield* attempt(() => {
          if (
            !this.host
              .getSnapshot()
              .can({ type: "CONFIGURE_NETWORK", active: this.active !== null })
          )
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
        const fiber = yield* this.admissions.withPermit(
          Effect.gen({ self: this }, function* () {
            const joining = this.recovery
            if ((yield* this.check("recover")) === "join") {
              if (!joining)
                return yield* Effect.die("Missing terminal recovery fiber")
              return joining
            }
            const ownerId = crypto.randomUUID()
            yield* this.repository.recover(ownerId)
            yield* this.observe("RECOVERY_STARTED")
            let confirmed = false
            const begin = yield* Deferred.make<void>()
            const work = Deferred.await(begin).pipe(
              Effect.andThen(this.options.runtime.close()),
              preserveFatal,
              Effect.catchTag("TerminalRuntimeError", () =>
                this.observe("CLEANUP_FAILED")
              ),
              Effect.ensuring(this.options.runtime.settle()),
              Effect.onExit((exit) =>
                Exit.isFailure(exit)
                  ? this.observe("CLEANUP_FAILED")
                  : Effect.void
              ),
              Effect.tap(() =>
                Effect.sync(() => {
                  confirmed =
                    this.host.getSnapshot().context.cleanupError === null
                })
              ),
              Effect.ensuring(
                Effect.suspend(() =>
                  this.repository.release(ownerId, confirmed)
                ).pipe(orDieAll)
              ),
              Effect.ensuring(
                this.observe("RECOVERY_FINISHED").pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      if (this.recovery === active) this.recovery = null
                    })
                  )
                )
              )
            )
            this.recovery = yield* FiberSet.run(
              this.tasks,
              Effect.interruptible(work)
            )
            const active = this.recovery
            yield* Deferred.succeed(begin, undefined)
            return active
          })
        )
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
      this.check("open").pipe(
        Effect.andThen(
          this.admissions.withPermit(
            Effect.uninterruptible(
              Effect.gen({ self: this }, function* () {
                const decoded = yield* Schema.decodeUnknownEffect(CommandInput)(
                  input
                ).pipe(
                  Effect.mapError(
                    () =>
                      new TerminalFailure({
                        message: "Invalid command request.",
                      })
                  )
                )
                yield* this.check("open")
                const existing = yield* this.repository.get(decoded.id)
                if (!existing) yield* this.check("resources")
                const { run, fresh } = yield* this.repository.claim(
                  decoded,
                  kind,
                  transfer?.plan,
                  crypto.randomUUID()
                )
                if (!fresh)
                  return {
                    run: commandResult(run),
                    completion:
                      this.active?.id === run.id
                        ? Fiber.join(this.active.fiber)
                        : Effect.void,
                  }
                const admission = yield* Effect.exit(this.check("open"))
                if (Exit.isFailure(admission)) {
                  yield* this.repository.finish(
                    run.id,
                    {
                      status: "cancelled",
                      exitCode: null,
                      error:
                        "The terminal host stopped before dispatch. This command was not executed.",
                    },
                    undefined,
                    undefined,
                    run.attemptId
                  )
                  yield* this.repository.release(run.attemptId, true)
                  return yield* Effect.failCause(admission.cause)
                }
                const controller = new AbortController()
                const sessionScope = yield* Scope.make()
                const session =
                  kind === "session"
                    ? yield* makeInteractiveSession(
                        run.id,
                        controller,
                        this.options.relay,
                        this.clock
                      ).pipe(Effect.provideService(Scope.Scope, sessionScope))
                    : undefined
                const begin = yield* Deferred.make<void>()
                const work = Deferred.await(begin).pipe(
                  Effect.andThen(
                    this.perform(
                      run,
                      controller,
                      sessionScope,
                      session,
                      transfer?.bytes
                    )
                  ),
                  Effect.ensuring(
                    Effect.sync(() => {
                      controller.abort()
                      session?.dispose()
                      if (this.active?.attemptId === run.attemptId)
                        this.active = null
                    })
                  ),
                  Effect.onExit((exit) => Scope.close(sessionScope, exit))
                )
                const fiber = yield* FiberSet.run(
                  this.tasks,
                  Effect.interruptible(work)
                )
                this.active = {
                  id: run.id,
                  attemptId: run.attemptId,
                  authorityRevision: run.authorityRevision ?? -1,
                  controller,
                  fiber,
                  session,
                }
                yield* Deferred.succeed(begin, undefined)
                return {
                  run: commandResult(run),
                  completion: Fiber.join(fiber),
                }
              })
            )
          )
        )
      )
  )
  cancel = Effect.fn("Terminal.cancel")((id: string) =>
    Effect.suspend(() => {
      Schema.decodeUnknownSync(CommandInput.fields.id)(id)
      let accepted: AbortController | undefined
      return this.repository
        .cancel(id, () => {
          if (this.active?.id === id) accepted = this.active.controller
        })
        .pipe(
          Effect.map((run) => (run ? commandResult(run) : null)),
          Effect.ensuring(Effect.sync(() => accepted?.abort()))
        )
    })
  )
  private perform(
    run: CommandRecord,
    controller: AbortController,
    sessionScope: Scope.Closeable,
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
        return this.repository.progress(run.id, next, run.attemptId).pipe(
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
    let timer: EffectActor<ReturnType<typeof terminalDeadlineMachine>>
    const changeDeadline = (deadline: number) =>
      Effect.gen(function* () {
        yield* send(timer, { type: "SET", deadline })
        const state = yield* waitFor(
          timer,
          (state) =>
            state.context.deadline === deadline || state.status !== "active"
        ).pipe(Effect.orDie)
        if (state.status !== "active")
          return yield* new TerminalFailure({ message: "Stopped or timed out" })
        yield* attempt(live)
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
    const permitted = Effect.gen({ self: this }, function* () {
      yield* attempt(live)
      const current = yield* this.repository.get(run.id)
      if (
        !current ||
        current.attemptId !== run.attemptId ||
        current.status !== "running" ||
        current.occupancy.ownerId !== run.attemptId ||
        current.occupancy.state !== "held" ||
        (yield* this.repository.cancelled(run.id)) ||
        !(yield* this.repository.authorized(current))
      )
        return yield* new TerminalFailure({
          message:
            "This command no longer owns an authorized terminal attempt.",
        })
    })
    const work = executeTerminal<TerminalOperationError>({
      kind: run.kind ?? "command",
      close: attempt(live).pipe(
        Effect.andThen(runtime.close()),
        Effect.andThen(attempt(live))
      ),
      restore: Effect.gen({ self: this }, function* () {
        yield* permitted
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
      }),
      command: permitted.pipe(
        Effect.andThen(runtime.execute(run.command, append, controller.signal))
      ),
      import: permitted.pipe(
        Effect.andThen(
          Effect.suspend((): Effect.Effect<void, TerminalOperationError> =>
            run.transfer && inputBytes
              ? runtime.importFile(
                  run.transfer.path,
                  inputBytes,
                  controller.signal
                )
              : Effect.fail(
                  new TerminalFailure({ message: "Import unavailable" })
                )
          )
        )
      ),
      export: Effect.gen(function* () {
        yield* permitted
        if (!exportStorage || !run.transfer)
          return yield* new TerminalFailure({ message: "Export unavailable" })
        const bytes = yield* runtime.exportFile(
          run.transfer.path,
          controller.signal
        )
        yield* attempt(() => {
          live()
          if (!bytes.length || bytes.length > MAX_TRANSFER_BYTES)
            throw new TerminalFailure({ message: "File size" })
        })
        const exported = yield* exportStorage.write(bytes)
        yield* attempt(live)
        return exported
      }),
      session: Effect.gen(function* () {
        yield* permitted
        if (!session)
          return yield* new TerminalFailure({ message: "Session unavailable" })
        yield* session.ready(yield* runtime.openInteractive(controller.signal))
        yield* changeDeadline(session.maximumAt)
        yield* session.completion
        yield* attempt(live)
        yield* changeDeadline(now() + 10_000)
        yield* session.settleConnections()
        yield* attempt(live)
        yield* session.closeRuntime()
        yield* attempt(live)
      }),
      checkpoint: Effect.gen(function* () {
        yield* attempt(live)
        const snapshot = yield* runtime.snapshot(controller.signal)
        yield* attempt(() => {
          live()
          if (snapshot.length > MAX_CHECKPOINT)
            throw new TerminalFailure({ message: "Checkpoint limit" })
        })
        const saved = yield* backups.write(snapshot)
        yield* attempt(live)
        return saved
      }),
    })
    const failure = () =>
      Effect.gen({ self: this }, function* () {
        controller.abort()
        yield* flush()
        yield* this.repository.finish(
          run.id,
          {
            status: "failed",
            exitCode: null,
            error: run.transfer
              ? "The file transfer could not finish. Use a regular file inside /workspace, up to 8 MB. The previous checkpoint is unchanged."
              : session
                ? "The terminal session ended or could not save. Recovery uses the last saved checkpoint."
                : "The command could not finish or save its workspace within the time/output limit. Inspect its output before starting another command. Recovery uses the last saved checkpoint.",
          },
          undefined,
          undefined,
          run.attemptId
        )
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
          this.observe("CLEANUP_FAILED")
        )
      )
    return Effect.acquireUseRelease(
      Effect.void,
      () =>
        Effect.scoped(
          Effect.gen({ self: this }, function* () {
            timer = yield* createEffectActor(
              terminalDeadlineMachine({
                now,
                expire: Effect.sync(() => controller.abort()),
              }),
              { input: { deadline: now() + COMMAND_TIMEOUT } }
            )
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
              result.exported,
              run.attemptId
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
        let confirmed = false
        const resources = Effect.sync(() => session?.dispose()).pipe(
          Effect.ensuring(runtime.settle()),
          Effect.ensuring(backups.settle()),
          Effect.ensuring(exportStorage ? exportStorage.settle() : Effect.void),
          Effect.ensuring(session ? session.settleConnections() : Effect.void),
          Effect.ensuring(Scope.close(sessionScope, Exit.void)),
          Effect.ensuring(finalizeClose()),
          Effect.onExit((exit) =>
            Exit.isFailure(exit) ? this.observe("CLEANUP_FAILED") : Effect.void
          ),
          Effect.tap(() =>
            Effect.sync(() => {
              confirmed = this.host.getSnapshot().context.cleanupError === null
            })
          )
        )
        const release = this.repository
          .cleaning(run.attemptId)
          .pipe(
            Effect.ensuring(resources),
            Effect.ensuring(
              Effect.suspend(() =>
                this.repository.release(run.attemptId, confirmed)
              ).pipe(orDieAll)
            ),
            orDieAll
          )
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
        yield* Clock.Clock,
        yield* createEffectActor(terminalServiceHostMachine)
      )
      yield* Effect.addFinalizer(() => terminal.shutdown())
      return terminal
    })
  )
