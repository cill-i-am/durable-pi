import type { Effect } from "effect"
import type { ConversationFailure } from "../conversations/turns"
import type {
  AppDetail,
  AppDocument,
  AppVersion,
  InteractApp,
  WebResult,
  SaveApp,
  PublishApp,
  ArchiveApp,
  AppEvent,
  AppConflict,
  AppStorageError,
} from "./contracts"

type AppError = AppConflict | AppStorageError

/** Interaction commands fence the published version after remote rendering. */
export interface WebAppRepository {
  detail: (id: string) => Effect.Effect<AppDetail, AppError>
  version: (id: string, version: number) => Effect.Effect<AppVersion, AppError>
  interactionReceipt: (
    input: InteractApp
  ) => Effect.Effect<AppDocument | undefined, AppError>
  interactionSnapshot: (
    input: InteractApp
  ) => Effect.Effect<AppDocument, AppError>
  interact: (
    input: InteractApp,
    result: WebResult
  ) => Effect.Effect<AppDocument, AppError>
}
export type WebAppRecords = WebAppRepository
export interface AppAdmission {
  readonly transactionGroup: object
  readonly admit: (
    event: AppEvent
  ) => Effect.Effect<string, ConversationFailure>
}
/** Receipt, state, events and shared admission writes commit atomically. */
export interface AppLedger extends WebAppRepository {
  readonly transactionGroup: object
  list: () => Effect.Effect<AppDocument[], AppError>
  get: (id: string) => Effect.Effect<AppDocument | undefined, AppError>
  save: (input: SaveApp) => Effect.Effect<AppDocument, AppError>
  publish: (input: PublishApp) => Effect.Effect<AppDocument, AppError>
  archive: (input: ArchiveApp) => Effect.Effect<AppDocument, AppError>
  interact: (
    input: InteractApp,
    result?: WebResult
  ) => Effect.Effect<AppDocument, AppError>
  pending: () => Effect.Effect<AppEvent[], AppError>
  cancelOperation: (id: string) => Effect.Effect<{ applied: boolean }, AppError>
  deliverNext: (
    admission: AppAdmission
  ) => Effect.Effect<boolean, AppError | ConversationFailure>
}
