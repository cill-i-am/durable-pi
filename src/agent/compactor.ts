import type { AssistantMessage, Message } from "@earendil-works/pi-ai"
import {
  byteLength,
  NODE_BYTES,
  nodeKey,
  type MemoryStore,
  type SummaryJob,
} from "./memory"
import { COMPACTOR_PROMPT } from "./prompts"

export const JOBS = 8
export const TRIES = 5
export const RETRY_MS = 10_000

// A realistic reference, exactly NODE_BYTES UTF-8 bytes. Tested, not model-counted.
const scale =
  "user: Keep the archive immutable and preserve exact wording, including corrections and reasons. Deploy only after checks pass; credentials stay private. talk: The service stores messages before acknowledging them and starts each turn from summaries. echo: Restart testing recovered all saved entries; the failed request was retried without duplicating data. user: Prefer web chat with searchable history. tool: Read the storage code and confirmed atomic writes. talk: Export and recovery still need verification."
export const SCALE = scale

export function cutUtf8(text: string, limit: number): string {
  // A streaming decoder retains an incomplete final character rather than emitting U+FFFD.
  return new TextDecoder().decode(
    new TextEncoder().encode(text).slice(0, limit),
    { stream: true }
  )
}

export type CompleteSummary = (request: {
  systemPrompt: string
  messages: Message[]
}) => Promise<AssistantMessage>

export async function summarize(
  job: SummaryJob,
  complete: CompleteSummary
): Promise<string> {
  if (byteLength(job.source) <= NODE_BYTES) return job.source
  const messages: Message[] = [
    {
      role: "user",
      timestamp: 0,
      content: [
        { type: "text", text: `<chat>\n${job.context}\n</chat>` },
        {
          type: "text",
          text: `For scale, this line is exactly ${NODE_BYTES} bytes:\n${SCALE}\n\n${job.count === 1 ? "Compress this message" : "Merge these two lines"} into one line, in at most ${NODE_BYTES} bytes:\n${job.children ? job.children.map((text) => text.replaceAll("\n", " ")).join("\n") : job.source}`,
        },
      ],
    },
  ]
  const attempts: string[] = []
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const reply = await complete({ systemPrompt: COMPACTOR_PROMPT, messages })
    if (reply.stopReason === "error" || reply.stopReason === "aborted")
      throw new Error("Summary provider unavailable")
    const text = reply.content
      .filter((x) => x.type === "text")
      .map((x) => x.text)
      .join("\n")
      .trim()
    if (!text) throw new Error("Empty summary")
    attempts.push(text)
    if (byteLength(text) <= NODE_BYTES) break
    messages.push(reply, {
      role: "user",
      timestamp: 0,
      content: `That line is ${byteLength(text)} bytes; the limit is ${NODE_BYTES}. It must end where it is cut here:\n${cutUtf8(text, NODE_BYTES)}| ← LIMIT`,
    })
  }
  return attempts.reduce((best, text) =>
    byteLength(text) < byteLength(best) ? text : best
  )
}

/** One Lifecycle job owns every promise. Refill after each completion; no detached work. */
export async function pumpSummaries(
  memory: MemoryStore,
  complete: CompleteSummary,
  options: {
    now?: () => number
    maxBuilds?: number
    timeBudgetMs?: number
    report?: (range: string) => void
  } = {}
) {
  const now = options.now ?? Date.now
  const maxBuilds = options.maxBuilds ?? 64
  const deadline = now() + (options.timeBudgetMs ?? 60_000)
  const busy = new Map<string, Promise<void>>()
  let started = 0
  for (;;) {
    while (busy.size < JOBS && started < maxBuilds && now() < deadline) {
      const job = memory.next(new Set(busy.keys()), now())
      if (!job) break
      const key = nodeKey(job)
      started++
      const work = summarize(job, complete)
        .then(
          (text) => memory.saveNode(job, text),
          () => {
            if (memory.failNode(job, now() + RETRY_MS)) options.report?.(key)
          }
        )
        .finally(() => busy.delete(key))
      busy.set(key, work)
    }
    if (!busy.size) break
    // Storage failures are fatal to the job, but join the other owned requests before returning.
    try {
      await Promise.race(busy.values())
    } catch (error) {
      await Promise.allSettled(busy.values())
      throw error
    }
  }
  return memory.next(new Set(), now()) ? now() : memory.retryAt()
}
