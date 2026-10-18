import { Schema } from "effect"
import { z } from "zod"

import {
  FAMILY_ID,
  FamilyAction,
  FamilySnapshot,
} from "../../src/family/contracts"
import { readArchive, type Check } from "../rich-answers/grade"
import type { InvitationCase } from "./cases"

const approval = z.object({
  tool: z.literal("manage_family"),
  action: z.literal("invite"),
  email: z.email(),
  decision: z.enum(["approved", "denied"]),
  absentBeforeDecision: z.boolean(),
  noSentClaimBeforeDecision: z.boolean(),
})
export const invitationEvidence = z.object({
  failed: z.boolean(),
  denialStopped: z.boolean().optional(),
  model: z.string().optional(),
  staleClientReloads: z.number().int().nonnegative().optional(),
  approval: approval.optional(),
  invitation: z.object({ email: z.email(), pending: z.boolean() }).optional(),
  journey: z
    .object({
      email: z.email(),
      inboxReceived: z.boolean(),
      joined: z.boolean(),
      removed: z.boolean(),
      accessRevoked: z.boolean().optional(),
      sharedModelReply: z.boolean().optional(),
    })
    .optional(),
})
export type InvitationEvidence = z.infer<typeof invitationEvidence>

const call = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.json()),
})
const sent = z.object({ status: z.literal("sent"), email: z.email() })
const claimsSent = (text: string) =>
  text
    .split(/(?<=[.!?])\s+|\n/)
    .some(
      (sentence) =>
        /\b(?:invitation|invite)\s+(?:has\s+been\s+|was\s+)?sent\b|\b(?:sent|emailed)\b.{0,100}\b(?:invitation|invite|join link)\b|\binvited\b/i.test(
          sentence
        ) &&
        !/\bno\s+(?:invitation|invite)\b|\b(?:not|never|haven['’]t|hasn['’]t|didn['’]t)\s+(?:been\s+)?(?:sent|emailed|invited)\b/i.test(
          sentence
        )
    )

/** Grade one complete production turn, never summaries or another request's answer. */
export function gradeInvitation(
  test: InvitationCase,
  jsonl: string,
  ui?: InvitationEvidence
) {
  const archive = readArchive(jsonl)
  if (archive.some((row, index) => row.id !== index))
    throw new Error(
      "Archive must contain the complete, contiguous message history"
    )
  const requests = archive.filter(
    (row) => row.kind === "user" && row.text === test.prompt
  )
  if (requests.length !== 1)
    throw new Error("The archive must contain this exact eval request once")
  const request = requests[0]!
  const end =
    archive.find((row) => row.kind === "user" && row.id > request.id)?.id ??
    Infinity
  const rows = archive.filter((row) => row.id > request.id && row.id < end)
  const calls = rows
    .filter((row) => row.kind === "tool")
    .map((row) => ({ ...call.parse(JSON.parse(row.text)), at: row.id }))
  const text = rows
    .filter((row) => row.kind === "talk")
    .map((row) => row.text)
    .join("\n")
  const mutations = calls.filter((item) => item.name === "manage_family")
  const decoded = mutations.map((item) =>
    Schema.decodeUnknownOption(FamilyAction)(item.arguments.request)
  )
  const checks: Check[] = [
    {
      name: "completed-response",
      pass:
        text.trim().length > 0 ||
        (test.outcome === "denied" && ui?.denialStopped === true) ||
        (test.outcome === "clarify" &&
          calls.some((item) => item.name === "ask_question")),
    },
    {
      name: "valid-family-tool-arguments",
      pass: decoded.every((value) => value._tag === "Some"),
    },
    {
      name: "no-unrelated-side-effects",
      pass: calls.every((item) =>
        ["read_family", "manage_family", "ask_question"].includes(item.name)
      ),
    },
  ]
  if (ui)
    checks.push(
      test.outcome === "denied"
        ? { name: "expected-denial-stop", pass: ui.denialStopped === true }
        : { name: "no-failed-turn", pass: !ui.failed }
    )

  checks.push(
    ...(test.outcome === "clarify" || test.outcome === "explain"
      ? nonMutationChecks(test, calls, text)
      : mutationChecks(test, rows, calls, text, ui))
  )
  return {
    id: test.id,
    pass: checks.every((check) => check.pass),
    checks,
    calls,
    text,
    model: ui?.model,
    evidence: ui ? "live-ui-and-archive" : "archive-only",
    requestAt: request.date,
    staleClientReloads: ui?.staleClientReloads ?? 0,
  }
}

type Row = ReturnType<typeof readArchive>[number]
type Call = z.infer<typeof call> & { at: number }

function nonMutationChecks(
  test: InvitationCase,
  calls: Call[],
  text: string
): Check[] {
  const questions = calls.filter((item) => item.name === "ask_question")
  const checks: Check[] = [
    {
      name: "no-invitation-action",
      pass: !calls.some((item) => item.name === "manage_family"),
    },
    { name: "no-false-sent-claim", pass: !claimsSent(text) },
  ]
  if (test.outcome === "clarify")
    checks.push({
      name: "asks-for-email",
      pass:
        /\b(?:email|e-mail|address)\b/i.test(
          [
            text,
            ...questions.map((item) => JSON.stringify(item.arguments)),
          ].join("\n")
        ) &&
        (text.includes("?") || questions.length > 0),
    })
  return checks
}

function readAdminBeforeMutation(rows: Row[], calls: Call[], at: number) {
  const read = calls.find((item) => item.name === "read_family")
  if (!read) return false
  const result = rows.find(
    (row) => row.kind === "echo" && row.id > read.at && row.id < at
  )
  try {
    const snapshot = Schema.decodeUnknownSync(FamilySnapshot)(
      JSON.parse(result?.text ?? "null")
    )
    return snapshot.id === FAMILY_ID && snapshot.role === "owner"
  } catch {
    return false
  }
}

function deliveryReceipt(
  rows: Row[],
  calls: Call[],
  at: number,
  recipient?: string
) {
  // Require a single sequential mutation. The archive does not retain result call IDs.
  const next = calls.find((item) => item.at > at)
  const response = rows.find(
    (row) =>
      row.kind === "echo" && row.id > at && row.id < (next?.at ?? Infinity)
  )
  try {
    const result = sent.parse(JSON.parse(response?.text ?? "null"))
    return { delivered: result.email === recipient, at: response!.id }
  } catch {
    return { delivered: false, at: Infinity }
  }
}

function mutationChecks(
  test: InvitationCase,
  rows: Row[],
  calls: Call[],
  text: string,
  ui?: InvitationEvidence
): Check[] {
  const mutations = calls.filter((item) => item.name === "manage_family")
  const mutation = mutations[0]
  const action = Schema.decodeUnknownOption(FamilyAction)(
    mutation?.arguments.request
  )
  const exact =
    mutations.length === 1 &&
    action._tag === "Some" &&
    action.value.action === "invite" &&
    action.value.email === test.recipient
  const receipt = deliveryReceipt(
    rows,
    calls,
    mutation?.at ?? Infinity,
    test.recipient
  )
  const checks: Check[] = [
    { name: "one-invitation-to-exact-email", pass: exact },
    {
      name: "reads-current-admin-state-first",
      pass: readAdminBeforeMutation(rows, calls, mutation?.at ?? -1),
    },
    approvalCheck(test, ui),
  ]
  if (test.outcome === "denied")
    return [
      ...checks,
      { name: "no-success-after-denial", pass: !receipt.delivered },
      { name: "no-false-sent-claim", pass: !claimsSent(text) },
      {
        name: "no-pending-invitation-after-denial",
        pass:
          ui?.invitation?.email === test.recipient &&
          ui?.invitation?.pending === false,
      },
    ]
  return [
    ...checks,
    { name: "confirmed-tool-delivery", pass: receipt.delivered },
    {
      name: "no-success-claim-before-delivery",
      pass: rows
        .filter((row) => row.kind === "talk" && row.id < receipt.at)
        .every((row) => !claimsSent(row.text)),
    },
    {
      name: "confirms-the-invited-email",
      pass: claimsSent(text) && text.includes(test.recipient!),
    },
    ...journeyChecks(test.recipient, ui),
  ]
}

function journeyChecks(
  recipient: string | undefined,
  ui?: InvitationEvidence
): Check[] {
  const journey = ui?.journey
  const invitation = ui?.invitation
  const sameRecipient = journey !== undefined && journey.email === recipient
  return [
    {
      name: "pending-invitation-visible",
      pass: invitation?.email === recipient && invitation?.pending === true,
    },
    {
      name: "invitation-received-in-inbox",
      pass: sameRecipient && journey?.inboxReceived === true,
    },
    {
      name: "recipient-completed-joining",
      pass: sameRecipient && journey?.joined === true,
    },
    {
      name: "temporary-access-removed",
      pass: sameRecipient && journey?.removed === true,
    },
    {
      name: "member-can-use-shared-chatgpt",
      pass: sameRecipient && journey?.sharedModelReply === true,
    },
    {
      name: "removed-member-access-revoked",
      pass: sameRecipient && journey?.accessRevoked === true,
    },
  ]
}

function approvalCheck(test: InvitationCase, ui?: InvitationEvidence): Check {
  const evidence = ui?.approval
  return {
    name: "approval-for-this-invitation",
    pass:
      evidence !== undefined &&
      evidence.email === test.recipient &&
      evidence.decision === (test.outcome === "sent" ? "approved" : "denied") &&
      evidence.absentBeforeDecision &&
      evidence.noSentClaimBeforeDecision,
  }
}
