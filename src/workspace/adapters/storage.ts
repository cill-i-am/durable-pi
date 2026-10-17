import { Effect } from "effect"

import type { Sqlite } from "../../storage/sqlite"
import type { ExtractDocument } from "../documents"
import { WorkspaceUnavailable } from "../files"
import { workspaceApplication } from "../service"
import type { ExtractVideo } from "../video"
import { r2WorkspaceAssets, type AssetBucket } from "./r2"
import { SqliteWorkspace } from "./sqlite"

export type { AssetBucket } from "./r2"
export function workspaceLayer(
  database: Sqlite,
  bucket: AssetBucket,
  prefix: string,
  canWrite: () => Effect.Effect<boolean, WorkspaceUnavailable> = () =>
    Effect.succeed(true),
  extractDocument: ExtractDocument = () =>
    Effect.fail(new WorkspaceUnavailable()),
  extractVideo: ExtractVideo = () => Effect.fail(new WorkspaceUnavailable())
) {
  return workspaceApplication(
    new SqliteWorkspace(database),
    r2WorkspaceAssets(bucket, prefix),
    canWrite,
    extractDocument,
    extractVideo
  )
}
