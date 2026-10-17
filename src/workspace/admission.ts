import { Context, type Effect } from "effect"

import type {
  FileId,
  FileInfo,
  FileNotFound,
  WorkspaceUnavailable,
  FileRejected,
  WorkspaceReadOnly,
} from "./files"

/** Final file eligibility reads share conversation admission's native transaction.
 * Attachment transport/preparation remains an Effect on Workspace. */
export class WorkspaceAdmission extends Context.Service<
  WorkspaceAdmission,
  {
    readonly transactionGroup: object
    requireFiles: (
      ids: readonly FileId[]
    ) => Effect.Effect<
      readonly FileInfo[],
      FileNotFound | WorkspaceUnavailable | FileRejected | WorkspaceReadOnly
    >
  }
>()("durable-pi/workspace/Admission") {}
