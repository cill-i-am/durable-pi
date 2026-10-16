import { preserveFatal, observeCleanup } from "../shared/effect"
import { Schema, Context, Deferred, Effect, Layer, Semaphore } from "effect"
import {
  ConnectionError,
  ConnectionStorageError,
  ConnectionTransportError,
  type ConnectionInfo,
  type NewConnection,
  type RemoteTool,
  type RemoteToolResult,
} from "./connections"
import type { ConnectionLedger, ConnectionFailure } from "./connection-ledger"
import type { ConnectionClient } from "./connection-client"
import {
  describeConnection,
  requireActiveConnection,
  requireToolGeneration,
} from "./connection-domain"

type OperationError = ConnectionFailure | ConnectionTransportError
export interface RemoteConnectionOperations {
  list: () => Effect.Effect<ConnectionInfo[], OperationError>
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

export const connectionApplication = (
  store: ConnectionLedger,
  client: ConnectionClient
) =>
  Layer.effect(
    RemoteConnections,
    Effect.gen(function* () {
      const mutations = yield* Semaphore.make(1)
      let closed = false,
        active = 0,
        changed = Deferred.makeUnsafe<void>()
      const requireOpen = () => {
        if (closed)
          throw new ConnectionError({
            message: "The connection host has stopped.",
          })
      }
      const operation = <T, TError>(work: Effect.Effect<T, TError>) =>
        Effect.acquireUseRelease(
          attempt(() => {
            requireOpen()
            active++
          }),
          () => work,
          () =>
            Effect.sync(() => {
              active--
              const previous = changed
              changed = Deferred.makeUnsafe<void>()
              Deferred.doneUnsafe(previous, Effect.void)
            })
        )
      const mutate = <T, TError>(work: Effect.Effect<T, TError>) =>
        operation(
          mutations
            .withPermit(attempt(requireOpen).pipe(Effect.andThen(work)))
            .pipe(
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
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          closed = true
          while (active) yield* Deferred.await(changed)
          yield* client.settle()
        })
      )
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
        connect: Effect.fn("Connections.connect")(
          (input: NewConnection, origin: string) =>
            mutate(
              Effect.gen(function* () {
                const record = yield* store.add(input)
                yield* attempt(() => requireActiveConnection(record))
                if ((yield* client.inspect(record.id)).registered) return
                yield* client.connect(record, origin)
              })
            )
        ),
        disconnect: Effect.fn("Connections.disconnect")(
          (id: string, revision: number) =>
            mutate(
              Effect.gen(function* () {
                yield* store.change(id, revision, false)
                yield* client.remove(id)
              })
            )
        ),
        reconnect: Effect.fn("Connections.reconnect")(
          (id: string, revision: number, origin: string) =>
            mutate(
              Effect.gen(function* () {
                const replay = (yield* store.get(id))?.revision === revision + 1
                const record = yield* store.change(id, revision, true)
                if (replay && (yield* client.inspect(id)).registered) return
                yield* client.remove(id)
                yield* client.connect(record, origin)
              })
            )
        ),
        refresh: Effect.fn("Connections.refresh")((id: string) =>
          mutate(
            Effect.gen(function* () {
              const record = yield* store.get(id)
              yield* attempt(() => requireActiveConnection(record))
              yield* client.discover(id)
            })
          )
        ),
        callback: Effect.fn("Connections.callback")((request: Request) =>
          mutate(
            Effect.gen(function* () {
              if (!(yield* client.isCallback(request)))
                return yield* new ConnectionError({
                  message: "Unknown authorization callback.",
                })
              const result = yield* client.callback(request)
              const connectionId = result.connectionId
              if (!result.authenticated || !connectionId)
                return yield* new ConnectionError({
                  message: "Authorization failed.",
                })
              const record = yield* store.get(connectionId)
              yield* attempt(() => requireActiveConnection(record))
              yield* client.establish(connectionId)
            })
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
