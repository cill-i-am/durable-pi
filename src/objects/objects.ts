import type { Effect } from "effect"

import type {
  ObjectContext,
  ObjectDetail,
  ObjectFailure,
  ObjectMutation,
  ChangeSource,
  MutationReceipt,
  ObjectSummary,
} from "./contracts"

export type WorkingObjects = {
  list: () => Effect.Effect<ObjectSummary[], ObjectFailure>
  read: (
    id: string,
    before?: number
  ) => Effect.Effect<ObjectDetail, ObjectFailure>
  mutate: (
    input: ObjectMutation,
    source: ChangeSource
  ) => Effect.Effect<MutationReceipt, ObjectFailure>
  cancel: (
    operationId: string
  ) => Effect.Effect<{ applied: boolean }, ObjectFailure>
  context: () => Effect.Effect<ObjectContext, ObjectFailure>
  offered: (sequence: number) => Effect.Effect<void, ObjectFailure>
}
