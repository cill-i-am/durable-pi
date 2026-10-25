import { Schema } from "effect"

import { ObjectMutation } from "@/objects/contracts"

import { ObjectDraft } from "./object-edit.machine"

export type ObjectStorage = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}
const Stored = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  drafts: Schema.Array(ObjectDraft),
})
export function readObjectDrafts(raw: string | null): readonly ObjectDraft[] {
  const value: unknown = JSON.parse(raw ?? "[]")
  const drafts = Array.isArray(value)
    ? Schema.decodeUnknownSync(Schema.Array(ObjectMutation))(value).map(
        (input) => ({
          input,
          pending: true,
          replaces: [],
          problem: {
            kind: "uncertain" as const,
            message:
              "A previous save was not confirmed. Retry the same change or cancel it safely.",
            input,
          },
        })
      )
    : Schema.decodeUnknownSync(Stored)(value).drafts
  const objects = new Set<string>(),
    operations = new Set<string>()
  for (const draft of drafts) {
    if (
      draft.pending
        ? draft.problem !== null && draft.problem.kind !== "uncertain"
        : draft.problem === null || draft.problem.kind === "uncertain"
    )
      throw new Error(
        "Saved object changes contain an inconsistent pending outcome."
      )
    if (
      objects.has(draft.input.id) ||
      operations.has(draft.input.operationId) ||
      (draft.problem &&
        JSON.stringify(draft.problem.input) !== JSON.stringify(draft.input))
    )
      throw new Error("Saved object changes contain conflicting identities.")
    objects.add(draft.input.id)
    operations.add(draft.input.operationId)
  }
  return drafts.map((draft) =>
    draft.pending && !draft.problem
      ? {
          ...draft,
          problem: {
            kind: "uncertain" as const,
            message:
              "A previous save was not confirmed. Retry the same change or cancel it safely.",
            input: draft.input,
          },
        }
      : draft
  )
}
export function writeObjectDrafts(drafts: readonly ObjectDraft[]) {
  // The empty legacy representation remains readable by older browser releases.
  return drafts.length
    ? JSON.stringify({ schemaVersion: 1, workflowVersion: 1, drafts })
    : "[]"
}
