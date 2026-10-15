import type { Effect } from "effect"
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

/** Atomic interaction commands fence the published version and revision again
 * after remote rendering. Receipt and state/event changes commit together. */
export interface WebAppRecords {
  detail: (id: string) => AppDetail
  version: (id: string, version: number) => AppVersion
  interactionReceipt: (input: InteractApp) => AppDocument | undefined
  interactionSnapshot: (input: InteractApp) => AppDocument
  interact: (input: InteractApp, result: WebResult) => AppDocument
}

export interface AppAdmission {
  readonly transactionGroup: object
  readonly admit: (event: AppEvent) => string
}

/** Commands execute atomically. Admission uses this same transaction group;
 * callbacks are synchronous and cannot hand off work to another runtime. */
export interface AppLedger extends WebAppRecords {
  readonly transactionGroup: object
  list: () => AppDocument[]
  get: (id: string) => AppDocument | undefined
  save: (input: SaveApp) => AppDocument
  publish: (input: PublishApp) => AppDocument
  archive: (input: ArchiveApp) => AppDocument
  interact: (input: InteractApp, result?: WebResult) => AppDocument
  pending: () => AppEvent[]
  cancelOperation: (id: string) => { applied: boolean }
  deliverNext: (admission: AppAdmission) => boolean
}

type AppError = AppConflict | AppStorageError
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
