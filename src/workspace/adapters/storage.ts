import { Effect } from "effect"

import type { Sqlite } from "../../storage/sqlite"
import { WorkspaceUnavailable } from "../files"
import { workspaceApplication, type WorkspaceProcessing } from "../service"
import { r2WorkspaceAssets, type AssetBucket } from "./r2"
import { SqliteWorkspace } from "./sqlite"

export type { AssetBucket } from "./r2"
export function workspaceLayer(
  database: Sqlite,
  bucket: AssetBucket,
  prefix: string,
  canWrite: () => Effect.Effect<boolean, WorkspaceUnavailable> = () =>
    Effect.succeed(true),
  processing: Partial<WorkspaceProcessing> = {}
) {
  return workspaceApplication(
    new SqliteWorkspace(database),
    r2WorkspaceAssets(bucket, prefix),
    canWrite,
    processing
  )
}
