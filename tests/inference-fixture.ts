import { createModels } from "@earendil-works/pi-ai/models"
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai"

import { catalogFromAccount } from "../src/inference/adapters/openai-catalog"

export const account = {
  models: ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"].map((slug) => ({
    slug,
    display_name: slug,
    visibility: "list",
    supported_in_api: true,
    context_window: 272000,
    input_modalities: ["text", "image"],
    supported_reasoning_levels: ["low", "medium", "high", "xhigh"].map(
      (effort) => ({ effort })
    ),
  })),
}
const models = createModels()
models.setProvider(openaiProvider())
export const catalog = catalogFromAccount(
  account,
  models.getModels("openai"),
  "2026-09-01T00:00:00.000Z"
)
export const credential = {
  type: "oauth" as const,
  access: "synthetic-local-access",
  refresh: "synthetic-local-refresh",
  clientId: "local-test",
  expires: Date.now() + 3600000,
}
export function response(
  model: string,
  kind: "text" | "tool" = "text",
  terminal = "response.completed"
) {
  const id = `resp_${crypto.randomUUID()}`
  const item =
    kind === "tool"
      ? {
          type: "function_call",
          id: "fc_one",
          call_id: "call_one",
          name: "save_result",
          arguments: "{}",
          status: "completed",
        }
      : {
          type: "message",
          id: "msg_one",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "Saved and verified.",
              annotations: [],
            },
          ],
        }
  const events = [
    {
      type: "response.created",
      response: { id, model, status: "in_progress" },
    },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    ...(terminal === "interrupted"
      ? []
      : [
          {
            type: terminal,
            response: {
              id,
              model,
              status:
                terminal === "response.completed"
                  ? "completed"
                  : terminal === "response.failed"
                    ? "failed"
                    : "incomplete",
              output: [item],
              usage: {
                input_tokens: 123,
                input_tokens_details: { cached_tokens: 100 },
                output_tokens: 17,
                total_tokens: 140,
              },
              ...(terminal === "response.failed"
                ? {
                    error: {
                      code: "subscription_sharing_usage_limit_exceeded",
                      message: "Plan usage limit",
                    },
                  }
                : {}),
            },
          },
        ]),
  ]
  return new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
      )
      .join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } }
  )
}
