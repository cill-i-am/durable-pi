import { Schema, Context, Effect, Layer } from "effect"
import {
  conversationFailure,
  type ConversationFailure,
} from "../conversations/turns"
import {
  AppConflict,
  AppStorageError,
  type AppDocument,
  type AppDetail,
  type AppVersion,
  type AppEvent,
  type SaveApp,
  type PublishApp,
  type ArchiveApp,
  type InteractApp,
  type WebResult,
} from "./contracts"
import type { AppAdmission, AppLedger } from "./repository"

export type AppError = AppConflict | AppStorageError
export class Apps extends Context.Service<
  Apps,
  {
    list: () => Effect.Effect<AppDocument[], AppError>
    get: (id: string) => Effect.Effect<AppDocument | undefined, AppError>
    detail: (id: string) => Effect.Effect<AppDetail, AppError>
    version: (
      id: string,
      version: number
    ) => Effect.Effect<AppVersion, AppError>
    save: (input: SaveApp) => Effect.Effect<AppDocument, AppError>
    publish: (input: PublishApp) => Effect.Effect<AppDocument, AppError>
    archive: (input: ArchiveApp) => Effect.Effect<AppDocument, AppError>
    interact: (
      input: InteractApp,
      result?: WebResult
    ) => Effect.Effect<AppDocument, AppError>
    interactionReceipt: (
      input: InteractApp
    ) => Effect.Effect<AppDocument | undefined, AppError>
    interactionSnapshot: (
      input: InteractApp
    ) => Effect.Effect<AppDocument, AppError>
    pending: () => Effect.Effect<AppEvent[], AppError>
    cancelOperation: (
      id: string
    ) => Effect.Effect<{ applied: boolean }, AppError>
    deliverNext: (
      admission: AppAdmission
    ) => Effect.Effect<boolean, AppError | ConversationFailure>
  }
>()("durable-pi/apps/Apps") {}

const attempt = <T>(body: () => T) =>
  Effect.try({
    try: body,
    catch(cause) {
      const knownFailure = Schema.decodeUnknownOption(
        Schema.Union([AppConflict, AppStorageError])
      )(cause)
      if (knownFailure._tag === "Some") return knownFailure.value
      throw cause
    },
  })
export const makeApps = (ledger: AppLedger) =>
  Apps.of({
    list: Effect.fn("Apps.list")(() => attempt(() => ledger.list())),
    get: Effect.fn("Apps.get")((id: string) => attempt(() => ledger.get(id))),
    detail: Effect.fn("Apps.detail")((id: string) =>
      attempt(() => ledger.detail(id))
    ),
    version: Effect.fn("Apps.version")((id: string, version: number) =>
      attempt(() => ledger.version(id, version))
    ),
    save: Effect.fn("Apps.save")((input: SaveApp) =>
      attempt(() => ledger.save(input))
    ),
    publish: Effect.fn("Apps.publish")((input: PublishApp) =>
      attempt(() => ledger.publish(input))
    ),
    archive: Effect.fn("Apps.archive")((input: ArchiveApp) =>
      attempt(() => ledger.archive(input))
    ),
    interact: Effect.fn("Apps.interact")(
      (input: InteractApp, result?: WebResult) =>
        attempt(() => ledger.interact(input, result))
    ),
    interactionReceipt: Effect.fn("Apps.interactionReceipt")(
      (input: InteractApp) => attempt(() => ledger.interactionReceipt(input))
    ),
    interactionSnapshot: Effect.fn("Apps.interactionSnapshot")(
      (input: InteractApp) => attempt(() => ledger.interactionSnapshot(input))
    ),
    pending: Effect.fn("Apps.pending")(() => attempt(() => ledger.pending())),
    cancelOperation: Effect.fn("Apps.cancelOperation")((id: string) =>
      attempt(() => ledger.cancelOperation(id))
    ),
    deliverNext: Effect.fn("Apps.deliverNext")((admission: AppAdmission) =>
      Effect.try({
        try: () => ledger.deliverNext(admission),
        catch(cause) {
          const failure = conversationFailure(cause)
          if (failure) return failure
          const knownFailure2 = Schema.decodeUnknownOption(
            Schema.Union([AppConflict, AppStorageError])
          )(cause)
          if (knownFailure2._tag === "Some") return knownFailure2.value
          throw cause
        },
      })
    ),
  })
export const appApplication = (ledger: AppLedger) =>
  Layer.succeed(Apps, makeApps(ledger))
