import { expect, it } from "vitest"

import {
  advanceInput,
  canSubmitInput,
  type ConversationInputEvent,
} from "../src/conversations/input.machine"
import type { Turn } from "../src/conversations/turns"
import type { FileInfo } from "../src/workspace/files"

const file: FileInfo = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "notes.txt",
  mime: "text/plain",
  kind: "text",
  size: 12,
  createdAt: "2026-10-23T00:00:00Z",
  status: "ready",
  trashed: false,
}
const turn: Turn = {
  id: "root",
  text: "Request",
  status: "queued",
  answer: "",
  error: null,
  created_at: "2026-10-23T00:00:00Z",
  session_id: null,
  prompt: null,
  parent_id: null,
  mode: "followUp",
  delivery: "queued",
  model: "test",
  thinking: "off",
  revision: 0,
  creation: null,
  attachments: [],
  input: [{ type: "text", text: "Attachment content" }],
  skill_context: "Skill instructions",
}
const events: readonly ConversationInputEvent[] = [
  { type: "PREPARE_ATTACHMENTS", prepared: { files: [], content: [] } },
  { type: "PIN_PROMPT", prompt: "Prompt" },
  { type: "PIN_SESSION", session: "session" },
  { type: "SUBMITTED", session: "session" },
  { type: "CONSUMED" },
  { type: "FINISH", delivery: "answered" },
]

it("cannot reopen terminal root statuses through any input event", () => {
  for (const status of ["done", "failed", "cancelled"] as const) {
    for (const delivery of ["queued", "accepted", "consumed"] as const) {
      const current = { ...turn, status, delivery, files_pending: true }
      for (const event of events)
        expect(advanceInput(current, event)).toBeUndefined()
      expect(canSubmitInput(current)).toBe(false)
    }
  }
})
it("keeps final input receipts terminal even while the root remains pending", () => {
  for (const delivery of ["answered", "unanswered"] as const) {
    const current = { ...turn, delivery, files_pending: true }
    for (const event of events)
      expect(advanceInput(current, event)).toBeUndefined()
    expect(canSubmitInput(current)).toBe(false)
  }
})
it("prepares only the originally admitted attachments while preparation is open", () => {
  const current = { ...turn, files_pending: true, attachments: [file] }
  const prepared = {
    files: [{ ...file, size: 20 }],
    content: [{ type: "text" as const, text: "Prepared contents" }],
  }
  expect(
    advanceInput(current, { type: "PREPARE_ATTACHMENTS", prepared })
  ).toMatchObject({
    files_pending: false,
    attachments: prepared.files,
    input: prepared.content,
  })
  expect(() =>
    advanceInput(current, {
      type: "PREPARE_ATTACHMENTS",
      prepared: {
        ...prepared,
        files: [{ ...file, id: "22222222-2222-2222-2222-222222222222" }],
      },
    })
  ).toThrow("Prepared attachments do not match the admitted request")
  for (const closed of [
    { ...current, files_pending: false },
    { ...current, prompt: "Pinned" },
    { ...current, status: "running" as const },
    { ...current, status: "stopping" as const },
  ])
    expect(
      advanceInput(closed, { type: "PREPARE_ATTACHMENTS", prepared })
    ).toBeUndefined()
})
it("pins the prompt once and clears the incorporated input and skill context", () => {
  const pinned = advanceInput(turn, { type: "PIN_PROMPT", prompt: "Pinned" })!
  expect(pinned).toMatchObject({
    prompt: "Pinned",
    input: [],
    skill_context: "",
    revision: turn.revision,
  })
  for (const prompt of ["Pinned", "Changed"])
    expect(advanceInput(pinned, { type: "PIN_PROMPT", prompt })).toBeUndefined()
  expect(
    advanceInput(
      { ...turn, files_pending: true },
      { type: "PIN_PROMPT", prompt: "Too early" }
    )
  ).toBeUndefined()
  expect(turn.prompt).toBeNull()
  expect(turn.input).toHaveLength(1)
})
it("pins the session once and rejects a receipt for another session", () => {
  const pinned = advanceInput(turn, {
    type: "PIN_SESSION",
    session: "session",
  })!
  expect(pinned.session_id).toBe("session")
  for (const session of ["session", "different"])
    expect(
      advanceInput(pinned, { type: "PIN_SESSION", session })
    ).toBeUndefined()
  expect(
    advanceInput(pinned, { type: "SUBMITTED", session: "different" })
  ).toBeUndefined()
  expect(
    advanceInput(pinned, { type: "SUBMITTED", session: "session" })
  ).toMatchObject({ delivery: "accepted", session_id: "session" })
})
it("records an acquired session after Stop so the owner can clean it up", () => {
  const stopping = advanceInput(
    { ...turn, status: "stopping" },
    { type: "PIN_SESSION", session: "late" }
  )!
  expect(stopping).toMatchObject({
    status: "stopping",
    session_id: "late",
    delivery: "queued",
  })
  expect(canSubmitInput(stopping)).toBe(false)
  expect(
    advanceInput(stopping, { type: "SUBMITTED", session: "late" })
  ).toBeUndefined()
  expect(
    advanceInput(stopping, { type: "PIN_SESSION", session: "replacement" })
  ).toBeUndefined()
})
it("accepts attachment preparation errors as data for the enclosing root transition", () => {
  expect(
    advanceInput(
      { ...turn, files_pending: true, attachments: [file] },
      {
        type: "PREPARE_ATTACHMENTS",
        prepared: { files: [file], content: [], error: "Extraction failed" },
      }
    )
  ).toMatchObject({ files_pending: false, attachments: [file], input: [] })
})
it("acknowledges an unchanged preparation result only while preparation remains open", () => {
  const current = { ...turn, files_pending: true, attachments: [file] }
  const event = {
    type: "PREPARE_ATTACHMENTS" as const,
    prepared: {
      pending: true,
      files: current.attachments,
      content: current.input,
      error: "Extraction remains unavailable",
    },
  }
  expect(advanceInput(current, event)).toBe(current)
  for (const closed of [
    { ...current, files_pending: false },
    { ...current, prompt: "Pinned" },
    { ...current, status: "stopping" as const },
    { ...current, status: "failed" as const },
  ])
    expect(advanceInput(closed, event)).toBeUndefined()
})
it("accepts a native receipt with its session and cannot regress consumed input", () => {
  const submitted = advanceInput(turn, {
    type: "SUBMITTED",
    session: "session",
  })!
  expect(submitted).toMatchObject({
    delivery: "accepted",
    session_id: "session",
  })
  const consumed = advanceInput(submitted, { type: "CONSUMED" })!
  expect(consumed.delivery).toBe("consumed")
  expect(
    advanceInput(consumed, { type: "SUBMITTED", session: "session" })
  ).toBeUndefined()
  expect(advanceInput(consumed, { type: "CONSUMED" })).toBeUndefined()
  expect(canSubmitInput(consumed)).toBe(true)
  expect(advanceInput(turn, { type: "CONSUMED" })).toMatchObject({
    delivery: "consumed",
  })
})
it("records final delivery while clearing prepared data and retaining the session", () => {
  for (const delivery of ["answered", "unanswered"] as const) {
    const current = {
      ...turn,
      status: "stopping" as const,
      session_id: "session",
      prompt: "Pinned",
      files_pending: true,
      attachments: [file],
    }
    const finished = advanceInput(current, { type: "FINISH", delivery })!
    expect(finished).toMatchObject({
      delivery,
      status: "stopping",
      session_id: "session",
      files_pending: false,
      input: [],
      prompt: null,
      skill_context: "",
      attachments: [file],
    })
    expect(advanceInput(finished, { type: "FINISH", delivery })).toBeUndefined()
  }
})
it("derives native submission eligibility from the machine transition", () => {
  for (const status of [
    "queued",
    "preparing",
    "running",
    "stopping",
  ] as const) {
    for (const delivery of ["queued", "accepted", "consumed"] as const) {
      const current = { ...turn, status, delivery }
      expect(canSubmitInput(current)).toBe(status !== "stopping")
      expect(canSubmitInput({ ...current, files_pending: true })).toBe(false)
    }
  }
})
it("rejects malformed event payloads and executable fields before a transition", () => {
  for (const event of [
    null,
    {},
    { type: "UNKNOWN" },
    { type: "PIN_PROMPT", prompt: 1 },
    { type: "PIN_SESSION" },
    { type: "SUBMITTED", session: false },
    { type: "FINISH", delivery: "accepted" },
    { type: "PREPARE_ATTACHMENTS", prepared: { files: [], content: "bad" } },
    {
      type: "PREPARE_ATTACHMENTS",
      prepared: { files: [], content: [], error: 1 },
    },
    { type: "PIN_PROMPT", prompt: "Prompt", actions: [{ type: "send" }] },
    { type: "CONSUMED", invoke: { src: "execute" } },
    { type: "CONSUMED", after: 100 },
  ])
    expect(() => advanceInput(turn, event as ConversationInputEvent)).toThrow()
})
it("rejects invalid restored lifecycle values", () => {
  for (const current of [
    { ...turn, status: "unknown" },
    { ...turn, delivery: "unknown" },
  ])
    expect(() => canSubmitInput(current as Turn)).toThrow()
})
