import { Schema, Effect, Layer } from "effect"
import type { Sqlite } from "../../storage/sqlite"
import { WorkspaceUnavailable } from "../files"
import { workspaceApplication } from "../service"
import type { ExtractDocument } from "../documents"
import type { ExtractVideo } from "../video"
import { SqliteWorkspace } from "./sqlite"
import { r2WorkspaceAssets, type AssetBucket } from "./r2"

export type { AssetBucket } from "./r2"
export function workspaceLayer(
  database: Sqlite,
  bucket: AssetBucket,
  prefix: string,
  canWrite: () => boolean = () => true,
  extractDocument: ExtractDocument = () =>
    Effect.fail(new WorkspaceUnavailable()),
  extractVideo: ExtractVideo = () => Effect.fail(new WorkspaceUnavailable())
) {
  return Layer.unwrap(
    Effect.try({
      try: () =>
        workspaceApplication(
          new SqliteWorkspace(database),
          r2WorkspaceAssets(bucket, prefix),
          canWrite,
          extractDocument,
          extractVideo
        ),
      catch: (cause) => {
        const workspaceUnavailable =
          Schema.decodeUnknownOption(WorkspaceUnavailable)(cause)
        if (workspaceUnavailable._tag === "Some")
          return workspaceUnavailable.value
        throw cause
      },
    })
  )
}
