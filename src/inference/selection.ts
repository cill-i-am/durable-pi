import { Schema } from "effect"

export const ThinkingLevel = Schema.Literals([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
])
export type ThinkingLevel = typeof ThinkingLevel.Type
export const ModelSettings = Schema.Struct({
  model: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  thinking: ThinkingLevel,
})
export type ModelSettings = typeof ModelSettings.Type
