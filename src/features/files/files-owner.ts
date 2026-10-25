import { createEffectActor, send } from "@xstate/effect"
import { Deferred, Effect, Schema } from "effect"

import { agentApi } from "@/http/client"
import { nativeOperation } from "@/shared/interop"
import { FileInfo, FileList, MAX_ATTACHMENTS } from "@/workspace/files"

import type { makeFilesCache } from "./file-cache"
import { fileMutationMachine } from "./file-mutation.machine"
import { fileRefreshMachine } from "./file-refresh.machine"
import type { FileAction, UploadAttempt } from "./file-types"
import { fileWorkFailures } from "./owned-work"
import { uploadFile } from "./uploads"
import { uploadsMachine } from "./uploads.machine"

export type FilesCache = ReturnType<typeof makeFilesCache>

/** One Effect scope owns every file request for this agent. Commands may stop
 * observing on disposal; native requests still abort and join in that scope. */
export const makeFilesOwner = (agentId: string, cache: FilesCache) =>
  Effect.gen(function* () {
    const closed = yield* Deferred.make<void>()
    yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined))
    const observe = yield* fileWorkFailures
    const api = agentApi(agentId)
    const query = yield* createEffectActor(
      fileRefreshMachine(
        () =>
          nativeOperation(
            (signal) =>
              api("files", undefined, signal).then(
                Schema.decodeUnknownSync(FileList)
              ),
            (error) => error
          ).pipe(
            Effect.map((value) => value.files),
            observe
          ),
        cache.replace,
        ({ file, mode, attach }) =>
          mode === "upload" ? cache.uploaded(file, attach) : cache.updated(file)
      )
    )
    const commit = (
      file: FileInfo,
      mode: "upload" | "update",
      attach: boolean
    ) =>
      Effect.gen(function* () {
        const reply = yield* Deferred.make<void>()
        yield* send(query, { type: "COMMIT", file, mode, attach, reply })
        yield* Deferred.await(reply)
      })
    const uploads = yield* createEffectActor(
      uploadsMachine(
        (attempt) =>
          nativeOperation(
            (signal) =>
              uploadFile(agentId, { ...attempt, status: "uploading" }, signal),
            (error) => error
          ).pipe(observe),
        (attempt, file) => commit(file, "upload", attempt.attach)
      )
    )
    const mutations = yield* createEffectActor(
      fileMutationMachine(
        (request) =>
          nativeOperation(
            (signal) =>
              api(
                `files/${request.id}/${request.action}`,
                { name: request.name },
                signal
              ).then(Schema.decodeUnknownSync(FileInfo)),
            (error) => error
          ).pipe(observe),
        (file) => commit(file, "update", false)
      )
    )
    const settled = <A>(reply: Deferred.Deferred<A>, fallback: A) =>
      Effect.raceFirst(
        Deferred.await(reply),
        Deferred.await(closed).pipe(Effect.as(fallback))
      )
    const start = (
      requests: readonly Omit<UploadAttempt, "status">[],
      retry: boolean
    ) =>
      Effect.gen(function* () {
        const reply = yield* Deferred.make<void>()
        const capacity = requests.some((item) => item.attach)
          ? MAX_ATTACHMENTS - cache.read().selected.length
          : MAX_ATTACHMENTS
        yield* send(uploads, {
          type: "START",
          requests,
          retry,
          capacity,
          reply,
        })
        yield* settled(reply, undefined)
      })
    const read = () => ({
      uploads: uploads.getSnapshot().context.attempts,
      uploading: uploads.getSnapshot().matches("uploading"),
      loading: query.getSnapshot().matches("loading"),
      error:
        uploads.getSnapshot().context.error ||
        mutations.getSnapshot().context.error ||
        query.getSnapshot().context.error,
    })
    return {
      cache,
      read,
      subscribe: (listener: () => void) => {
        const subscriptions = [
          query.subscribe(listener),
          uploads.subscribe(listener),
          mutations.subscribe(listener),
        ]
        return () =>
          subscriptions.forEach((subscription) => subscription.unsubscribe())
      },
      refresh: () =>
        Effect.gen(function* () {
          yield* send(uploads, { type: "CLEAR_ERROR" })
          yield* send(mutations, { type: "CLEAR_ERROR" })
          const reply = yield* Deferred.make<void>()
          yield* send(query, { type: "REFRESH", reply })
          yield* settled(reply, undefined)
        }),
      upload: (chosen: readonly File[], attach: boolean) =>
        Effect.suspend(() => {
          const used = new Set<string>()
          const requests = chosen.map((file) => {
            const id =
              cache
                .read()
                .files.find(
                  (saved) =>
                    !used.has(saved.id) &&
                    saved.status === "uploading" &&
                    !saved.trashed &&
                    saved.name === file.name &&
                    saved.size === file.size
                )?.id ?? crypto.randomUUID()
            used.add(id)
            return { id, file, attach }
          })
          return start(requests, false)
        }),
      retry: (attempt: UploadAttempt) => start([attempt], true),
      dismiss: (id: string) => send(uploads, { type: "DISMISS", id }),
      mutate: (id: string, action: FileAction, name?: string) =>
        Effect.gen(function* () {
          const reply = yield* Deferred.make<boolean>()
          yield* send(mutations, { type: "MUTATE", id, action, name, reply })
          return yield* settled(reply, false)
        }),
    }
  })
export type FilesOwner = Effect.Success<ReturnType<typeof makeFilesOwner>>
