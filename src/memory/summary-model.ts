import { Context, Schema, type Effect } from "effect"

/** Provider-neutral conversation for byte-budget feedback. No SDK messages enter memory. */
export type SummaryMessage = { role: "user" | "assistant"; text: string }
export class SummaryFailure extends Schema.TaggedError<SummaryFailure>()(
  "SummaryFailure",
  {
    reason: Schema.Literals(["unavailable", "empty", "timeout"]),
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
      messages: readonly SummaryMessage[]
    ) => Effect.Effect<string, SummaryFailure>
  }
>()("durable-pi/memory/SummaryModel") {}
