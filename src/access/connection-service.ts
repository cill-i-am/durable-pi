import { createEffectActor, send, waitFor } from "@xstate/effect"
import {
  Schema,
  Clock,
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  Scope,
  Semaphore,
} from "effect"

import {
  preserveFatal,
  observeCleanup,
  orDieAll,
  fatalCause,
} from "../shared/effect"
import type { ConnectionClient } from "./connection-client"
import {
  connectionCommandMachine,
  type ConnectionAdmission,
  type ConnectionCommandKind,
} from "./connection-command.machine"
import {
  describeConnection,
  requireActiveConnection,
  requireToolGeneration,
  requireConnectionWrite,
} from "./connection-domain"
import { connectionHostMachine } from "./connection-host.machine"
import type { ConnectionLedger, ConnectionFailure } from "./connection-ledger"
import {
  ConnectionError,
  ConnectionStorageError,
  ConnectionTransportError,
  type ConnectionInfo,
  type NewConnection,
  type SavedConnection,
  type RemoteTool,
  type RemoteToolResult,
} from "./connections"
import { executorDefaultTools } from "./executor"

type OperationError = ConnectionFailure | ConnectionTransportError
export interface RemoteConnectionOperations {
  list: () => Effect.Effect<ConnectionInfo[], OperationError>
  defaults: () => Effect.Effect<RemoteTool[], OperationError>
  connect: (
    input: NewConnection,
    origin: string
  ) => Effect.Effect<void, OperationError>
  disconnect: (
    id: string,
    revision: number
  ) => Effect.Effect<void, OperationError>
  reconnect: (
    id: string,
    revision: number,
    origin: string
  ) => Effect.Effect<void, OperationError>
  refresh: (id: string) => Effect.Effect<void, OperationError>
  callback: (request: Request) => Effect.Effect<void, OperationError>
  resolve: (
    names: readonly string[]
  ) => Effect.Effect<RemoteTool[], OperationError>
  call: (
    name: string,
    input: Record<string, unknown>
  ) => Effect.Effect<RemoteToolResult, OperationError>
}
export class RemoteConnections extends Context.Service<
  RemoteConnections,
  RemoteConnectionOperations
>()("durable-pi/access/RemoteConnections") {}
const attempt = <T>(body: () => T) =>
  Effect.try({
    try: body,
    catch: (cause) => {
      const knownFailure = Schema.decodeUnknownOption(
        Schema.Union([ConnectionError, ConnectionStorageError])
      )(cause)
      if (knownFailure._tag === "Some") return knownFailure.value
      throw cause
    },
  })
const unavailable = () =>
  new ConnectionError({
    message:
      "A selected tool is unavailable or has changed. Refresh its connection.",
  })
const failedCall = (): RemoteToolResult => ({
  content: [
    {
      type: "text",
      text: "The connected tool could not complete. Check the connection and the remote service before retrying; an external action may have started.",
    },
  ],
  isError: true,
})

export interface ConnectionAuthority {
  readonly deadline: number
  readonly current: () => boolean
}
export const connectionApplication = (
  store: ConnectionLedger,
  client: ConnectionClient,
  authorize: () => Effect.Effect<ConnectionAuthority | null, OperationError>
) =>
  Layer.effect(
    RemoteConnections,
    Effect.gen(function* () {
      const clock = yield* Clock.clockWith(Effect.succeed)
      const mutations = yield* Semaphore.make(1)
      const hostScope = yield* Scope.make()
      const host = yield* createEffectActor(connectionHostMachine).pipe(
        Scope.provide(hostScope)
      )
      const requireOpen = () => {
        if (!host.getSnapshot().matches("open"))
          throw new ConnectionError({
            message: "The connection host has stopped.",
          })
      }
      const authority = () =>
        Effect.gen(function* () {
          yield* attempt(requireOpen)
          const receipt = yield* authorize()
          if (!receipt)
            return yield* new ConnectionError({
              message: "Connection access is no longer available.",
            })
          yield* attempt(() => {
            requireOpen()
            requireConnectionWrite(eligible(receipt)())
          })
          return receipt
        })
      const eligible = (receipt: ConnectionAuthority) => () =>
        host.getSnapshot().matches("open") &&
        Number.isFinite(receipt.deadline) &&
        clock.currentTimeMillisUnsafe() < receipt.deadline &&
        receipt.current()
      const current = (record: SavedConnection, cleanup = false) =>
        Effect.gen(function* () {
          const verify = (saved: SavedConnection | undefined) => {
            if (
              !saved ||
              saved.revision !== record.revision ||
              saved.active !== record.active
            )
              throw new ConnectionError({
                message: "This connection changed. Reload before updating it.",
              })
            if (!cleanup) requireActiveConnection(saved)
          }
          yield* attempt(() => {
            if (!cleanup) requireOpen()
          })
          const observed = yield* store.get(record.id)
          yield* attempt(() => verify(observed))
          if (cleanup) return
          // Fresh lookup follows delayed storage, then the synchronous receipt
          // fences an observed revocation while the final ledger read waits.
          const receipt = yield* authority()
          const saved = yield* store.get(record.id)
          yield* attempt(() => {
            verify(saved)
            requireConnectionWrite(eligible(receipt)())
          })
        })
      const operation = <T, TError>(work: Effect.Effect<T, TError>) =>
        Effect.suspend(() => {
          let failure: Cause.Cause<TError> | null = null
          return Effect.acquireUseRelease(
            Effect.gen(function* () {
              const id = crypto.randomUUID()
              yield* send(host, { type: "ADMIT", id })
              const state = yield* waitFor(
                host,
                (snapshot) =>
                  snapshot.context.active.includes(id) ||
                  !snapshot.matches("open")
              ).pipe(orDieAll)
              if (!state.context.active.includes(id))
                yield* attempt(requireOpen)
              return id
            }),
            () =>
              work.pipe(
                Effect.onExit((exit) =>
                  Effect.sync(() => {
                    if (Exit.isFailure(exit)) failure = exit.cause
                  })
                )
              ),
            (id) =>
              Effect.gen(function* () {
                yield* send(host, { type: "RELEASE", id, failure })
                yield* waitFor(
                  host,
                  (state) => !state.context.active.includes(id)
                ).pipe(orDieAll)
              })
          )
        })
      const mutate = <T, TError>(work: Effect.Effect<T, TError>) =>
        operation(
          mutations.withPermit(authority().pipe(Effect.andThen(work))).pipe(
            (timed) =>
              observeCleanup(timed, (observed) =>
                observed.pipe(Effect.timeout("60 seconds"))
              ),
            preserveFatal,
            Effect.catchTag("TimeoutError", (cause) =>
              Effect.fail(
                new ConnectionTransportError({
                  operation: "connection deadline",
                  cause,
                })
              )
            )
          )
        )
      yield* Effect.addFinalizer((exit) =>
        Effect.gen(function* () {
          yield* send(host, { type: "CLOSE" })
          yield* waitFor(host, (state) => state.matches("settling")).pipe(
            orDieAll
          )
          const settlement = yield* Effect.exit(client.settle())
          const failure = host.getSnapshot().context.failure
          const reasons = [
            ...(failure?.reasons ?? []),
            ...(Exit.isFailure(settlement) ? settlement.cause.reasons : []),
          ]
          yield* send(host, { type: "SETTLED" })
          yield* waitFor(host, (state) => state.status === "done").pipe(
            orDieAll
          )
          if (reasons.length)
            return yield* Effect.failCause(
              fatalCause(Cause.fromReasons(reasons))
            )
        }).pipe(Effect.ensuring(Scope.close(hostScope, exit)))
      )
      const command = (
        kind: ConnectionCommandKind,
        admit: (
          eligible: () => boolean
        ) => Effect.Effect<ConnectionAdmission, OperationError>,
        origin = "",
        request?: Request
      ) =>
        Effect.suspend(() => {
          let late: Cause.Cause<OperationError> | undefined
          const watch = <A>(work: Effect.Effect<A, OperationError>) =>
            work.pipe(
              Effect.onExit((exit) =>
                Effect.sync(() => {
                  if (Exit.isFailure(exit)) late = exit.cause
                })
              )
            )
          const guarded = <A>(
            record: SavedConnection,
            work: Effect.Effect<A, OperationError>,
            cleanup = false
          ) =>
            watch(
              current(record, cleanup).pipe(
                Effect.andThen(work),
                Effect.tap(() => current(record, cleanup))
              )
            )
          const machine = connectionCommandMachine(kind, {
            admit: watch(
              Effect.gen(function* () {
                const receipt = yield* authority()
                return yield* admit(eligible(receipt))
              })
            ),
            inspect: (record) =>
              guarded(
                record,
                client
                  .inspect(record.id)
                  .pipe(Effect.map((state) => state.registered))
              ),
            remove: (record) =>
              guarded(record, client.remove(record.id), !record.active),
            register: (record) =>
              guarded(record, client.register(record, origin)),
            connect: (record) => guarded(record, client.connect(record)),
            discover: (record) => guarded(record, client.discover(record.id)),
            authorize: watch(
              Effect.suspend(() =>
                authority().pipe(
                  Effect.flatMap((receipt) =>
                    client.callback(request!, eligible(receipt))
                  )
                )
              )
            ),
            acceptCallback: (result, candidates) =>
              watch(
                Effect.gen(function* () {
                  const prior = candidates.find(
                    (record) =>
                      record.id === result.connectionId &&
                      record.revision === result.revision
                  )
                  if (!result.authenticated || !prior)
                    return yield* new ConnectionError({
                      message:
                        "Authorization failed or its connection changed.",
                    })
                  yield* current(prior)
                  return prior
                })
              ),
            establish: (record) => guarded(record, client.establish(record.id)),
          })
          return Effect.gen(function* () {
            const actor = yield* createEffectActor(machine)
            const state = yield* waitFor(
              actor,
              (snapshot) => snapshot.status === "done"
            ).pipe(orDieAll)
            return yield* state.context.outcome!
          }).pipe(
            Effect.scoped,
            Effect.onExit((exit) => {
              if (
                !Exit.isFailure(exit) ||
                !Cause.hasInterrupts(exit.cause) ||
                !late ||
                !Cause.hasDies(late)
              )
                return Effect.void
              const reasons = late.reasons.filter(
                (reason) =>
                  reason._tag !== "Interrupt" &&
                  !exit.cause.reasons.includes(reason)
              )
              return reasons.length
                ? Effect.failCause(Cause.fromReasons(reasons)).pipe(orDieAll)
                : Effect.void
            })
          )
        })
      const admission = (
        record: SavedConnection | null,
        replay = false,
        candidates: SavedConnection[] = []
      ): ConnectionAdmission => ({ record, replay, candidates })
      const list = Effect.fn("Connections.list")(function* () {
        const records = yield* store.list()
        return yield* Effect.forEach(
          records,
          (record) =>
            Effect.gen(function* () {
              const state = yield* client.inspect(record.id)
              const tools =
                record.active && state.phase === "ready"
                  ? yield* client.tools(record)
                  : []
              return describeConnection(record, state, tools)
            }),
          { concurrency: 4 }
        )
      })
      const resolve = Effect.fn("Connections.resolve")(function* (
        names: readonly string[]
      ) {
        yield* client.ready()
        const catalog = (yield* list()).flatMap(
          (connection) => connection.tools
        )
        return yield* attempt(() =>
          names.map((name) => {
            const found = catalog.find((tool) => tool.name === name)
            if (!found) throw unavailable()
            return found
          })
        )
      })
      return {
        list: () => operation(list()),
        defaults: () =>
          operation(
            client
              .ready()
              .pipe(Effect.andThen(list()), Effect.map(executorDefaultTools))
          ),
        connect: Effect.fn("Connections.connect")(
          (input: NewConnection, origin: string) =>
            mutate(
              command(
                "connect",
                (eligible) =>
                  store
                    .add(input, eligible)
                    .pipe(Effect.map((record) => admission(record))),
                origin
              )
            )
        ),
        disconnect: Effect.fn("Connections.disconnect")(
          (id: string, revision: number) =>
            mutate(
              command("disconnect", (eligible) =>
                store
                  .change(id, revision, false, eligible)
                  .pipe(Effect.map((record) => admission(record)))
              )
            )
        ),
        reconnect: Effect.fn("Connections.reconnect")(
          (id: string, revision: number, origin: string) =>
            mutate(
              command(
                "reconnect",
                (eligible) =>
                  Effect.gen(function* () {
                    const prior = yield* store.get(id)
                    const record = yield* store.change(
                      id,
                      revision,
                      true,
                      eligible
                    )
                    return admission(record, prior?.revision === revision + 1)
                  }),
                origin
              )
            )
        ),
        refresh: Effect.fn("Connections.refresh")((id: string) =>
          mutate(
            command("refresh", () =>
              Effect.gen(function* () {
                const record = yield* store.get(id)
                yield* attempt(() => requireActiveConnection(record))
                return admission(record!)
              })
            )
          )
        ),
        callback: Effect.fn("Connections.callback")((request: Request) =>
          mutate(
            command(
              "callback",
              () =>
                Effect.gen(function* () {
                  const candidates = (yield* store.list()).filter(
                    (record) => record.active
                  )
                  if (!(yield* client.isCallback(request)))
                    return yield* new ConnectionError({
                      message: "Unknown authorization callback.",
                    })
                  return admission(null, false, candidates)
                }),
              "",
              request
            )
          )
        ),
        resolve: (names) => operation(resolve(names)),
        call: Effect.fn("Connections.call")(
          (name: string, input: Record<string, unknown>) =>
            operation(
              Effect.gen(function* () {
                const tools = yield* resolve([name])
                const tool = tools[0]!
                const record = yield* store.get(tool.connectionId)
                yield* attempt(() => requireToolGeneration(record, tool))
                yield* current(record!)
                return yield* client.call(tool, input)
              }).pipe(
                preserveFatal,
                Effect.catchTags({
                  ConnectionError: () => Effect.sync(failedCall),
                  ConnectionTransportError: () => Effect.sync(failedCall),
                })
              )
            )
        ),
      } satisfies RemoteConnectionOperations
    })
  )
