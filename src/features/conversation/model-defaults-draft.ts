import { Schema } from "effect"

import { ModelSelection, ModelSettings } from "@/conversations/turns"
import { type ModelCatalogResponse } from "@/inference/catalog-api"
import { JobType, resolveRoute } from "@/inference/policy"

export const ModelDefaultSave = Schema.Struct({
  agentId: Schema.String,
  job: JobType,
  draft: ModelSettings,
  editRevision: Schema.Int,
  settingsRevision: Schema.Number,
})
export type ModelDefaultSave = typeof ModelDefaultSave.Type
export const ModelDefaultSource = Schema.Struct({
  job: JobType,
  draft: ModelSettings,
  settingsRevision: Schema.Number,
})
export const ModelDefaultDraft = Schema.Struct({
  agentId: Schema.String,
  job: JobType,
  draft: ModelSettings,
  baseline: ModelSettings,
  editRevision: Schema.Int,
  settingsRevision: Schema.Number,
  dirty: Schema.Boolean,
  saved: Schema.Boolean,
  attempt: Schema.NullOr(ModelDefaultSave),
  accepted: Schema.NullOr(ModelSelection),
  error: Schema.String,
  failure: Schema.Unknown,
})
type State = typeof ModelDefaultDraft.Type
export function sourceModelDefaults(
  state: State,
  value: typeof ModelDefaultSource.Type
): State {
  if (
    value.job !== state.job ||
    value.settingsRevision < state.settingsRevision
  )
    return state
  return {
    ...state,
    baseline: value.draft,
    settingsRevision: value.settingsRevision,
    draft: !state.dirty && !state.attempt ? value.draft : state.draft,
  }
}
export function observeModelDefaults(
  state: State,
  catalog: ModelCatalogResponse
): State {
  return sourceModelDefaults(state, {
    job: state.job,
    draft: catalog.assignments[state.job] ?? resolveRoute(state.job),
    settingsRevision: catalog.selection.settingsRevision,
  })
}
export function acknowledgeModelDefaults(state: State): State {
  const attempt = state.attempt!,
    confirmed = state.accepted!
  const unchanged = attempt.editRevision === state.editRevision
  const baseline =
    confirmed.settingsRevision >= state.settingsRevision
      ? attempt.draft
      : state.baseline
  return {
    ...state,
    baseline,
    settingsRevision: Math.max(
      state.settingsRevision,
      confirmed.settingsRevision
    ),
    dirty: unchanged ? false : state.dirty,
    saved: unchanged,
    draft: unchanged || !state.dirty ? baseline : state.draft,
  }
}

/** Freeze the write independently of later edits in this feature. */
export function captureModelDefaultSave(state: State): ModelDefaultSave {
  return {
    agentId: state.agentId,
    job: state.job,
    draft: { model: state.draft.model, thinking: state.draft.thinking },
    editRevision: state.editRevision,
    settingsRevision: state.settingsRevision,
  }
}

export function matchesModelDefaultSave(
  attempt: ModelDefaultSave,
  catalog: ModelCatalogResponse
) {
  const current = catalog.assignments[attempt.job] ?? resolveRoute(attempt.job)
  return (
    catalog.selection.settingsRevision >= attempt.settingsRevision &&
    current.model === attempt.draft.model &&
    current.thinking === attempt.draft.thinking
  )
}

export function discardModelDefaultDraft(state: State): State {
  return {
    ...state,
    draft: state.baseline,
    editRevision: state.editRevision + 1,
    dirty: false,
    saved: false,
  }
}
