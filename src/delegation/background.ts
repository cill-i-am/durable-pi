import { Effect, Schema } from "effect"
import { DelegateInput, DelegationFailure, NativeId } from "./contracts"
import { ResolvedRoute } from "../inference/policy"
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
export const backgroundEffect = <T>(
  body: (signal: AbortSignal) => Promise<T>
) =>
  Effect.tryPromise({
    try: body,
    catch: (cause) =>
      cause instanceof DelegationFailure
        ? cause
        : backgroundFailure(
            "Background task state could not be confirmed. Retry the same operation."
          ),
  })
export const backgroundObjectName = (parent: string, id: number) =>
  `background:${parent}:${id}`
