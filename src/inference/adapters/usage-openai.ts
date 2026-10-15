import { Option, Schema } from "effect"
import type { UsageReport } from "../usage-domain"

const Tokens = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const TerminalUsage = Schema.Struct({
  type: Schema.Literals([
    "response.completed",
    "response.incomplete",
    "response.failed",
  ]),
  response: Schema.Struct({
    id: Schema.String,
    model: Schema.String,
    usage: Schema.Struct({
      input_tokens: Tokens,
      input_tokens_details: Schema.Struct({ cached_tokens: Tokens }),
      output_tokens: Tokens,
    }),
  }),
})
const decode = Schema.decodeUnknownOption(TerminalUsage)

/** An absent or malformed report is unreported usage, never invented zeroes.
 * Decoding selects only accounting fields, not the provider's message content. */
export function providerUsage(event: unknown): UsageReport | undefined {
  const decoded = decode(event)
  if (Option.isNone(decoded)) return undefined
  const { id, model, usage } = decoded.value.response
  if (usage.input_tokens_details.cached_tokens > usage.input_tokens)
    return undefined
  return {
    id,
    model,
    input: usage.input_tokens,
    cached: usage.input_tokens_details.cached_tokens,
    output: usage.output_tokens,
  }
}
