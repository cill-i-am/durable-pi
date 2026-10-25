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
  renderSnapshot: (
    id: string,
    version: number
  ) => Effect.Effect<AppDocument, AppError>
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
    result: WebResult,
    discoveryDeadline?: number
  ) => Effect.Effect<AppDocument, AppError>
}
export type WebAppRecords = WebAppRepository
export interface AppAdmission {
  readonly transactionGroup: object
  readonly admit: (
    event: AppEvent,
    discoveryDeadline: number
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
    result?: WebResult,
    discoveryDeadline?: number
  ) => Effect.Effect<AppDocument, AppError>
  pending: () => Effect.Effect<AppEvent[], AppError>
  exhaustDelivery: (
    eligible: () => boolean,
    expiredOnly: boolean
  ) => Effect.Effect<void, AppError>
  nextDelivery: () => Effect.Effect<number | undefined, AppError>
  deferDelivery: (
    id: string,
    reason: "model" | "capacity" | "storage",
    now: number
  ) => Effect.Effect<void, AppError>
  cancelPending: (message: string) => Effect.Effect<void, AppError>
  renderSnapshot: (
    id: string,
    version: number
  ) => Effect.Effect<AppDocument, AppError>
  cancelOperation: (id: string) => Effect.Effect<{ applied: boolean }, AppError>
  deliverNext: (
    admission: AppAdmission,
    discoveryDeadline: number
  ) => Effect.Effect<boolean, AppError | ConversationFailure>
}
