import { Schema } from "effect"
import { describe, expect, it } from "vitest"

import {
  replyDeliveryProgress,
  replyProgressText,
  replyRetryLabel,
  ReplyDeliveryProgress,
} from "../src/replies/progress"

describe("public reply progress", () => {
  it("identifies the next provider message without exposing file IDs, reply text or receipts", () => {
    const progress = replyDeliveryProgress({
      version: 1,
      generation: 2,
      parts: [
        { text: "private answer", files: [] },
        { text: "", files: ["private-file"] },
        { text: "extra", files: ["other-file"] },
      ],
      receipts: ["private-provider-id"],
    })
    expect(Schema.decodeUnknownSync(ReplyDeliveryProgress)(progress)).toEqual({
      confirmed: 1,
      total: 3,
      next: { number: 2, kind: "files" },
    })
    expect(replyProgressText(progress)).toBe(
      "1 of 3 messages accepted by the provider. Next: message 2 (files)."
    )
    expect(JSON.stringify(progress)).not.toContain("private")
    expect(replyRetryLabel(progress)).toBe("Retry remaining messages")
    expect(replyRetryLabel()).toBe("Retry reply")
  })
  it("reports completed provider acceptance without inventing recipient delivery", () => {
    const progress = replyDeliveryProgress({
      version: 1,
      generation: 0,
      parts: [{ text: "answer", files: [] }],
      receipts: ["provider-id"],
    })
    expect(progress.next).toBeNull()
    expect(replyProgressText(progress)).toBe(
      "1 of 1 messages accepted by the provider."
    )
  })
})
