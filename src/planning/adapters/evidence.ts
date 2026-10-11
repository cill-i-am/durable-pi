import { Effect } from "effect"
import type { AccessStore } from "../../access/adapters/sqlite"
import type { ExecutionRepository } from "../../execution/execution"
import type { ObjectFailure, Checklist } from "../../objects/contracts"
import type { AppStore } from "../../apps/adapters/sqlite"
import type { FileInfo } from "../../workspace/files"
import { PlanFailure, type Evidence, type EvidenceRef } from "../contracts"

/** All supplied repositories already belong to the authenticated bot. No owner or bot IDs come from the model. */
export function planEvidence(sources: {
  access: AccessStore
  executions: ExecutionRepository
  object: (id: string) => Effect.Effect<Checklist | null, ObjectFailure>
  apps: AppStore
  files: () => Promise<FileInfo[]>
}) {
  return (
    ref: EvidenceRef,
    roots: readonly string[]
  ): Effect.Effect<Evidence, PlanFailure> =>
    Effect.tryPromise({
      try: async () => {
        const value = (valid: boolean, detail: string): Evidence => ({
          ...ref,
          state: valid ? "valid" : "invalid",
          detail,
        })
        switch (ref.kind) {
          case "receipt": {
            const receipt = sources.access.get(ref.id)
            if (
              !receipt ||
              !roots.includes(receipt.turnId) ||
              receipt.revision !== ref.revision ||
              receipt.status !== "done" ||
              !receipt.result ||
              ["update_plan", "read_plan"].includes(receipt.tool)
            )
              return value(
                false,
                "A successful receipt from this task at this revision is unavailable."
              )
            const result = JSON.parse(receipt.result) as {
              isError?: boolean
              content?: { type: string; text?: string }[]
            }
            let failed = !!result.isError
            if (["run_code", "run_command"].includes(receipt.tool)) {
              const text = result.content?.find(
                (block) => block.type === "text"
              )?.text
              const outcome = text
                ? (JSON.parse(text) as {
                    status?: string
                    exitCode?: number
                    error?: unknown
                    output?: { error?: unknown }
                  })
                : undefined
              failed ||=
                !outcome ||
                outcome.status !== "succeeded" ||
                !!outcome.error ||
                !!outcome.output?.error ||
                (receipt.tool === "run_command" && outcome.exitCode !== 0)
            }
            return value(
              !failed,
              failed
                ? "The tool recorded an error."
                : `${receipt.tool}: successful tool receipt. The claimed outcome is agent-reported.`
            )
          }
          case "execution": {
            const run = sources.executions.get(ref.id)
            return value(
              ref.revision === 0 &&
                run?.status === "succeeded" &&
                !!run.output &&
                !run.output.error,
              "Saved code execution result; semantic correctness is agent-reported."
            )
          }
          case "object": {
            const outcome = await Effect.runPromise(
              sources.object(ref.id).pipe(
                Effect.match({
                  onSuccess: (object) => object,
                  onFailure: (error) => {
                    if (error.code === "unavailable") throw error
                    return undefined
                  },
                })
              )
            )
            return value(
              !!outcome &&
                !outcome.archived &&
                outcome.revision === ref.revision,
              "Current checklist revision; completion of its contents is agent-reported."
            )
          }
          case "app": {
            const app = sources.apps.get(ref.id)
            return value(
              !!app && !app.archived && app.revision === ref.revision,
              "Current saved app revision; behavior and fitness are agent-reported."
            )
          }
          case "file": {
            const file = (await sources.files()).find(
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
      },
      catch: () =>
        new PlanFailure({
          code: "unavailable",
          message:
            "Evidence could not be checked. Saved completion has not been changed.",
        }),
    })
}
