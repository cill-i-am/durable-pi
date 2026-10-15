import { Context } from "effect"
import type { FileId, FileInfo } from "./files"

/** Final file eligibility reads share conversation admission's native transaction.
 * Attachment transport/preparation remains an Effect on Workspace. */
export class WorkspaceAdmission extends Context.Service<
  WorkspaceAdmission,
  {
    readonly transactionGroup: object
    requireFiles: (ids: readonly FileId[]) => readonly FileInfo[]
  }
>()("durable-pi/workspace/Admission") {}
