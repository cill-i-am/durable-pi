import { Context, Effect, Layer } from "effect"

import type { AppConflict, AppStorageError } from "./contracts"
import type { AppLedger } from "./repository"

export type AppError = AppConflict | AppStorageError
export class Apps extends Context.Service<
  Apps,
  Omit<AppLedger, "transactionGroup">
>()("durable-pi/apps/Apps") {}

export const makeApps = (ledger: AppLedger) =>
  Apps.of({
    list: Effect.fn("Apps.list")(() => ledger.list()),
    get: Effect.fn("Apps.get")((id) => ledger.get(id)),
    detail: Effect.fn("Apps.detail")((id) => ledger.detail(id)),
    version: Effect.fn("Apps.version")((id, version) =>
      ledger.version(id, version)
    ),
    save: Effect.fn("Apps.save")((input) => ledger.save(input)),
    publish: Effect.fn("Apps.publish")((input) => ledger.publish(input)),
    archive: Effect.fn("Apps.archive")((input) => ledger.archive(input)),
    interact: Effect.fn("Apps.interact")((input, result) =>
      ledger.interact(input, result)
    ),
    interactionReceipt: Effect.fn("Apps.interactionReceipt")((input) =>
      ledger.interactionReceipt(input)
    ),
    interactionSnapshot: Effect.fn("Apps.interactionSnapshot")((input) =>
      ledger.interactionSnapshot(input)
    ),
    pending: Effect.fn("Apps.pending")(() => ledger.pending()),
    cancelOperation: Effect.fn("Apps.cancelOperation")((id) =>
      ledger.cancelOperation(id)
    ),
    deliverNext: Effect.fn("Apps.deliverNext")((admission) =>
      ledger.deliverNext(admission)
    ),
  })
export const appApplication = (ledger: AppLedger) =>
  Layer.succeed(Apps, makeApps(ledger))
