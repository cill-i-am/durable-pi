import { describe, expect, it } from "vitest"

import { submissionAttempt } from "../src/features/conversation/commands"
import {
  adoptDraftOwner,
  draftKey,
  emptyDraft,
  readDraft,
  writeDraft,
} from "../src/features/conversation/draft"
import type { FileInfo } from "../src/workspace/files"

function storage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    key: (i) => [...values.keys()][i] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
    clear: () => values.clear(),
  }
}
const file: FileInfo = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  name: "voice.ogg",
  mime: "audio/ogg",
  kind: "audio",
  size: 100,
  createdAt: "today",
  status: "ready",
  trashed: false,
  audio: {
    source: "transcribed",
    characters: 19,
    truncated: false,
    language: "en",
    duration: 1,
  },
}

describe("tab-local composer recovery", () => {
  it("restores the exact uncertain send and file references without submitting work", () => {
    const store = storage(),
      draft = {
        ...emptyDraft(),
        text: "Keep this draft",
        files: [file],
        profile: "deep" as const,
      }
    readDraft(store, "owner", "agent")
    const attempt = submissionAttempt(
      null,
      draft.text,
      "followUp",
      [file.id],
      draft.profile
    )
    writeDraft(store, "owner", "agent", { ...draft, attempt })
    const restored = readDraft(store, "owner", "agent")
    expect(restored.text).toBe(draft.text)
    expect(restored.files[0]?.id).toBe(file.id)
    expect(restored.files[0]).not.toHaveProperty("audio")
    expect(
      submissionAttempt(
        restored.attempt,
        restored.text,
        "followUp",
        restored.files.map((f) => f.id),
        restored.profile
      )
    ).toEqual(attempt)
    expect(readDraft(store, "owner", "other-agent").text).toBe("")
  })
  it("round-trips a maximum escaped draft and its uncertain attempt within the serialized bound", () => {
    const store = storage()
    readDraft(store, "owner", "agent")
    const text = String.fromCharCode(1).repeat(30_000)
    const attempt = submissionAttempt(null, text, "followUp")
    writeDraft(store, "owner", "agent", { ...emptyDraft(), text, attempt })
    const restored = readDraft(store, "owner", "agent")
    expect(restored.text).toBe(text)
    expect(restored.attempt?.operationId).toBe(attempt.operationId)
  })
  it("clears private drafts on sign-out or person change and fences late writes", () => {
    const store = storage()
    readDraft(store, "owner", "agent")
    writeDraft(store, "owner", "agent", { ...emptyDraft(), text: "Private" })
    adoptDraftOwner(store, null)
    expect(store.getItem(draftKey("owner", "agent"))).toBeNull()
    expect(() =>
      writeDraft(store, "owner", "agent", {
        ...emptyDraft(),
        text: "Late private result",
      })
    ).toThrow()
    readDraft(store, "member", "agent")
    expect(readDraft(store, "member", "agent").text).toBe("")
    expect(() =>
      writeDraft(store, "owner", "agent", {
        ...emptyDraft(),
        text: "Wrong principal",
      })
    ).toThrow()
  })
  it("rejects malformed, excessive and forged draft data; confirmed empty drafts leave no recovery record", () => {
    const store = storage()
    readDraft(store, "owner", "agent")
    const key = draftKey("owner", "agent")
    for (const text of [
      "{broken",
      "x".repeat(500_001),
      JSON.stringify({ ...emptyDraft(), text: "x".repeat(30_001) }),
      JSON.stringify({
        ...emptyDraft(),
        files: Array.from({ length: 5 }, () => file),
      }),
    ]) {
      store.setItem(key, text)
      expect(() => readDraft(store, "owner", "agent")).toThrow()
      expect(store.getItem(key)).toBe(text)
    }
    writeDraft(store, "owner", "agent", { ...emptyDraft(), text: "draft" })
    writeDraft(store, "owner", "agent", emptyDraft())
    expect(store.getItem(key)).toBeNull()
  })
})

it("does not turn an unreadable or newer saved draft into a writable empty draft", () => {
  const store = storage()
  readDraft(store, "owner", "agent")
  const key = draftKey("owner", "agent")
  for (const raw of [
    "{broken",
    JSON.stringify({
      ...emptyDraft(),
      version: 2,
      text: "Retain the original draft",
      attempt: { operationId: "original-attempt" },
    }),
  ]) {
    store.setItem(key, raw)
    expect(() => readDraft(store, "owner", "agent")).toThrow()
    expect(store.getItem(key)).toBe(raw)
  }
})
