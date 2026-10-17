import { Schema } from "effect"

import { ResolvedRoute } from "../inference/policy"
import { DelegateInput, DelegationFailure, NativeId } from "./contracts"
import { validateBrief } from "./delegation"

export const BackgroundInput = Schema.Struct({
  objective: DelegateInput.fields.objective,
  tasks: Schema.Array(
    Schema.Struct({ name: Schema.String, task: Schema.String })
  ),
})
export type BackgroundInput = typeof BackgroundInput.Type
export const BackgroundHandoff = Schema.Struct({
  id: NativeId,
  parentObject: Schema.String,
  turnId: Schema.String,
  conversationId: NativeId,
  reportId: Schema.String,
  route: ResolvedRoute,
  memory: Schema.String,
  input: DelegateInput,
  createdAt: Schema.Number,
  deadline: Schema.Number,
})
export type BackgroundHandoff = typeof BackgroundHandoff.Type
export function backgroundBrief(input: unknown) {
  const value = Schema.decodeUnknownSync(BackgroundInput)(input)
  return validateBrief({
    ...value,
    tasks: value.tasks.map((task) => ({ ...task, tools: [] })),
  })
}
export const backgroundFailure = (message: string) =>
  new DelegationFailure({ code: "unavailable", message })
export const backgroundObjectName = (parent: string, id: number) =>
  `background:${parent}:${id}`
