import { Effect } from "effect"

import type { AccessError } from "../access/gate"
import type { ReceiptFact, ReceiptQuery } from "../access/receipt"
import type { AppDocument } from "../apps/contracts"
import type { AppError } from "../apps/service"
import type {
  CodeRun,
  ExecutionFailure,
  ExecutionStorageError,
} from "../execution/contracts"
import type { ObjectFailure, Checklist } from "../objects/contracts"
import { preserveFatal } from "../shared/effect"
import type { FileInfo, FileError } from "../workspace/files"
import { PlanFailure, type Evidence, type EvidenceRef } from "./contracts"

export interface EvidenceSources<TRequirements = never> {
  receipt: (
    query: ReceiptQuery
  ) => Effect.Effect<ReceiptFact | undefined, AccessError, TRequirements>
  execution: (
    id: string
  ) => Effect.Effect<
    CodeRun | undefined,
    ExecutionFailure | ExecutionStorageError,
    TRequirements
  >
  object: (
    id: string
  ) => Effect.Effect<Checklist | null, ObjectFailure, TRequirements>
  app: (
    id: string
  ) => Effect.Effect<AppDocument | undefined, AppError, TRequirements>
  files: () => Effect.Effect<FileInfo[], FileError, TRequirements>
}

export function planEvidence<TRequirements>(
  sources: EvidenceSources<TRequirements>
) {
  return (
    ref: EvidenceRef,
    roots: readonly string[]
  ): Effect.Effect<Evidence, PlanFailure, TRequirements> =>
    Effect.gen(function* () {
      const value = (valid: boolean, detail: string): Evidence => ({
        ...ref,
        state: valid ? "valid" : "invalid",
        detail,
      })
      switch (ref.kind) {
        case "receipt": {
          const receipt = yield* sources.receipt({
            id: ref.id,
            revision: ref.revision,
            roots,
          })
          return receiptEvidence(ref, roots, receipt)
        }
        case "execution": {
          const run = yield* sources.execution(ref.id)
          return value(
            ref.revision === 0 &&
              run?.status === "succeeded" &&
              !!run.output &&
              !run.output.error,
            "Saved code execution result; semantic correctness is agent-reported."
          )
        }
        case "object": {
          const object = yield* sources.object(ref.id).pipe(
            preserveFatal,
            Effect.catchTag("ObjectFailure", (error) =>
              error.code === "unavailable"
                ? Effect.fail(error)
                : Effect.succeed(undefined)
            )
          )
          return value(
            !!object && !object.archived && object.revision === ref.revision,
            "Current checklist revision; completion of its contents is agent-reported."
          )
        }
        case "app": {
          const app = yield* sources.app(ref.id)
          return value(
            !!app && !app.archived && app.revision === ref.revision,
            "Current saved app revision; behavior and fitness are agent-reported."
          )
        }
        case "file": {
          const file = (yield* sources.files()).find(
            (entry) => entry.id === ref.id
          )
          return value(
            ref.revision === 0 &&
              !!file &&
              file.status === "ready" &&
              !file.trashed,
            "Saved workspace file; its contents and suitability are agent-reported."
          )
        }
      }
    }).pipe(
      preserveFatal,
      Effect.mapError(
        () =>
          new PlanFailure({
            code: "unavailable",
            message:
              "Evidence could not be checked. Saved completion has not been changed.",
          })
      )
    )
}

function receiptEvidence(
  ref: EvidenceRef,
  roots: readonly string[],
  receipt: ReceiptFact | undefined
): Evidence {
  if (
    !receipt ||
    !roots.includes(receipt.turnId) ||
    receipt.revision !== ref.revision ||
    receipt.outcome === "unavailable"
  )
    return {
      ...ref,
      state: "invalid",
      detail:
        "A successful receipt from this task at this revision is unavailable.",
    }
  return {
    ...ref,
    state: receipt.outcome === "succeeded" ? "valid" : "invalid",
    detail:
      receipt.outcome === "failed"
        ? "The tool recorded an error."
        : `${receipt.tool}: successful tool receipt. The claimed outcome is agent-reported.`,
  }
}
