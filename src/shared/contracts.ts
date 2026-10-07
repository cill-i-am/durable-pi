import * as Schema from "effect/Schema"

export const SendInput = Schema.Struct({
  operationId: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/i)),
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(30_000)),
})
export const CancelInput = Schema.Struct({
  operationId: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/i)),
})
export type ChatTurn = {
  id: string
  text: string
  status: "queued" | "preparing" | "running" | "done" | "failed" | "cancelled"
  answer: string
  error: string | null
  created_at: string
  session_id: string | null
  prompt: string | null
}
export type ChatState = {
  turns: Omit<ChatTurn, "prompt" | "session_id">[]
  model: string
  connected: boolean
  memory: {
    messages: number
    summaries: number
    ready: boolean
    notes: {
      path: string
      body: string
      source_id: number
      updated_at: string
    }[]
  }
}
