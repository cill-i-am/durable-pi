import { Context, Schema, type Effect } from "effect"
import type { SummaryJob } from "./domain"

export type SummaryMessage = { role: "user" | "assistant"; text: string }
export class SummaryFailure extends Schema.TaggedError<SummaryFailure>()(
  "SummaryFailure",
  {
    reason: Schema.Literals(["unavailable", "empty", "timeout", "invalid"]),
  }
) {
  override get message() {
    return this.reason === "empty"
      ? "Empty summary"
      : `Summary provider ${this.reason}`
  }
}
export class SummaryModel extends Context.Service<
  SummaryModel,
  {
    complete: (
      messages: readonly SummaryMessage[],
      job: SummaryJob
    ) => Effect.Effect<string, SummaryFailure>
  }
>()("durable-pi/memory/SummaryModel") {}
