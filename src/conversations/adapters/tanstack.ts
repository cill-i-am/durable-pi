import {
  EventType,
  type StreamChunk,
  type UIMessage,
} from "@tanstack/ai/client"
import { Schema } from "effect"

import { ChatState, type TimelineItem } from "../contracts"

type Turn = ChatState["turns"][number]
type TurnDetails = Omit<Turn, "text" | "answer" | "activity">
type MessageDetails = {
  turnId: string
  kind: "request" | "answer" | TimelineItem["type"]
  itemId?: string
  turn?: TurnDetails
  attachments?: Extract<TimelineItem, { type: "steer" }>["attachments"]
  toolStatus?: Extract<TimelineItem, { type: "tool" }>["status"]
  copyAnswer?: string
  created_at?: string
  provenance?: Extract<TimelineItem, { type: "steer" }>["provenance"]
}

export type ChatMessage = UIMessage & {
  role: "user" | "assistant"
  content: string
  metadata: { durablePi: MessageDetails }
}

export function chatMessages(turns: readonly Turn[]): ChatMessage[] {
  return turns.flatMap(({ text, answer, activity, ...turn }) => {
    const make = (
      suffix: string,
      role: ChatMessage["role"],
      parts: UIMessage["parts"],
      details: Omit<MessageDetails, "turnId">
    ): ChatMessage => ({
      id: `${turn.id}:${suffix}`,
      role,
      content: "",
      parts,
      metadata: { durablePi: { turnId: turn.id, ...details } },
    })
    const messages = [
      make("request", "user", [{ type: "text", content: text }], {
        kind: "request",
        turn,
        ...(activity?.length &&
        answer !==
          activity
            .filter((item) => item.type === "text")
            .map((item) => item.text)
            .join("\n\n")
          ? { copyAnswer: answer }
          : {}),
      }),
    ]
    if (!activity?.length) {
      if (answer)
        messages.push(
          make("answer", "assistant", [{ type: "text", content: answer }], {
            kind: "answer",
          })
        )
      return messages
    }
    for (const item of activity) {
      const details = { kind: item.type, itemId: item.id } as const
      if (item.type === "tool") {
        const callId = `${turn.id}:${item.id}`
        messages.push(
          make(
            item.id,
            "assistant",
            [
              {
                type: "tool-call",
                id: callId,
                name: item.name,
                arguments: item.input,
                state: "input-complete",
              },
              {
                type: "tool-result",
                toolCallId: callId,
                content: item.output,
                state:
                  item.status === "done"
                    ? "complete"
                    : item.status === "error" || item.status === "interrupted"
                      ? "error"
                      : "streaming",
              },
            ],
            { ...details, toolStatus: item.status }
          )
        )
      } else {
        messages.push(
          make(
            item.id,
            item.type === "steer" ? "user" : "assistant",
            item.type === "thinking"
              ? [
                  { type: "thinking", content: item.text, stepId: item.id },
                  { type: "text", content: "" },
                ]
              : [{ type: "text", content: item.text }],
            {
              ...details,
              ...(item.type !== "thinking"
                ? { created_at: item.created_at }
                : {}),
              ...(item.type === "steer"
                ? { attachments: item.attachments, provenance: item.provenance }
                : {}),
            }
          )
        )
      }
    }
    return messages
  })
}

export function conversationView(
  messages: readonly UIMessage[],
  metadata: Omit<ChatState, "turns">
): ChatState {
  const turns = new Map<string, Turn>()
  const copyAnswers = new Map<string, string>()
  for (const message of messages) {
    const details = message.metadata?.durablePi as MessageDetails | undefined
    if (!details) continue
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.content)
      .join("")
    if (details.kind === "request" && details.turn) {
      if (details.copyAnswer !== undefined)
        copyAnswers.set(details.turnId, details.copyAnswer)
      turns.set(details.turnId, {
        ...details.turn,
        text,
        answer: "",
        activity: [],
      })
      continue
    }
    const turn = turns.get(details.turnId)
    if (!turn) continue
    if (details.kind === "answer") {
      turns.set(turn.id, { ...turn, answer: text })
      continue
    }
    const id = details.itemId ?? message.id
    const item = timelineMessage(message, details, id, text)
    if (item)
      turns.set(turn.id, {
        ...turn,
        activity: [...(turn.activity ?? []), item],
        answer:
          turn.answer +
          (item.type === "text"
            ? `${turn.answer ? "\n\n" : ""}${item.text}`
            : ""),
      })
  }
  return Schema.decodeUnknownSync(ChatState)({
    ...metadata,
    turns: [...turns.values()].map((turn) => ({
      ...turn,
      answer: copyAnswers.get(turn.id) ?? turn.answer,
    })),
  })
}

function timelineMessage(
  message: UIMessage,
  details: MessageDetails,
  id: string,
  text: string
): TimelineItem | undefined {
  let item: TimelineItem | undefined
  if (details.kind === "text")
    item = { id, type: "text", text, created_at: details.created_at }
  if (details.kind === "steer")
    item = {
      id,
      type: "steer",
      text,
      created_at: details.created_at,
      provenance: details.provenance,
      attachments: details.attachments,
    }
  if (details.kind === "thinking")
    item = {
      id,
      type: "thinking",
      text: message.parts
        .filter((part) => part.type === "thinking")
        .map((part) => part.content)
        .join(""),
    }
  if (details.kind === "tool") {
    const call = message.parts.find((part) => part.type === "tool-call")
    const result = message.parts.find(
      (part) => part.type === "tool-result" && part.toolCallId === call?.id
    )
    if (
      call &&
      result?.type === "tool-result" &&
      typeof result.content === "string"
    )
      item = {
        id,
        type: "tool",
        name: call.name,
        input: call.arguments,
        output: result.content,
        status: details.toolStatus ?? "interrupted",
      }
  }
  return item
}

function appendedTextEvents(
  previous: readonly ChatMessage[],
  next: ChatMessage[]
): StreamChunk[] | undefined {
  const appended = next.at(-1)
  const firstPart = appended?.parts[0]
  if (
    next.length === previous.length + 1 &&
    appended?.role === "assistant" &&
    appended.parts.length === 1 &&
    firstPart?.type === "text" &&
    firstPart.content.length > 0 &&
    !previous.some((message) => message.id === appended.id) &&
    previous.every(
      (message, index) =>
        JSON.stringify(message) === JSON.stringify(next[index])
    )
  )
    return [
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: appended.id,
        role: "assistant",
        metadata: appended.metadata,
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: appended.id,
        delta: firstPart.content,
      },
    ]
}

export function messageEvents(
  previous: readonly ChatMessage[] | undefined,
  next: ChatMessage[]
): StreamChunk[] {
  const appended = previous && appendedTextEvents(previous, next)
  if (appended) return appended
  if (previous?.length === next.length) {
    const changed = next.filter(
      (message, index) =>
        JSON.stringify(message) !== JSON.stringify(previous[index])
    )
    if (!changed.length) return []
    if (changed.length === 1) {
      const message = changed[0]!
      const before = previous.find((item) => item.id === message.id)
      const part = message.parts[0]
      const old = before?.parts[0]
      if (
        before &&
        message === next.at(-1) &&
        message.role === "assistant" &&
        part?.type === "text" &&
        old?.type === "text" &&
        message.parts.length === 1 &&
        before.parts.length === 1 &&
        part.content.startsWith(old.content) &&
        JSON.stringify({ ...message, parts: [] }) ===
          JSON.stringify({ ...before, parts: [] })
      )
        return [
          {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: message.id,
            delta: part.content.slice(old.content.length),
          },
        ]
    }
  }
  return [{ type: EventType.MESSAGES_SNAPSHOT, messages: next }]
}
