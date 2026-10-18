import { Buffer as NativeBuffer } from "node:buffer"
import { createHmac, timingSafeEqual } from "node:crypto"

import { Schema } from "effect"

import type { Approval } from "../../access/contracts"
import type { EmailApprovalProofs } from "../approvals"
import { EmailRejected } from "../contracts"

// Workers declares this Node export as any; retain Node's constructor contract.
const Buffer = NativeBuffer as BufferConstructor

const Proof = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(200)),
  turnId: Schema.String.check(Schema.isMaxLength(200)),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  expiresAt: Schema.Number,
})
const signature = (secret: string, recipient: string, payload: string) =>
  createHmac("sha256", secret)
    .update(
      JSON.stringify(["email-approval-v1", recipient.toLowerCase(), payload])
    )
    .digest()

export function emailApprovalToken(
  secret: string,
  recipient: string,
  approval: Approval
) {
  const payload = Buffer.from(
    JSON.stringify({
      id: approval.id,
      turnId: approval.turnId,
      revision: approval.revision,
      expiresAt: approval.expiresAt,
    })
  ).toString("base64url")
  return `${payload}.${signature(secret, recipient, payload).toString("base64url")}`
}
export function emailApprovalProof(
  secret: string,
  recipient: string,
  token: string,
  now: number
) {
  try {
    const [payload, mac, extra] = token.split(".")
    if (!payload || !mac || extra || token.length > 1800)
      throw new Error("Invalid token")
    const supplied = Buffer.from(mac, "base64url"),
      expected = signature(secret, recipient, payload)
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      throw new Error("Invalid signature")
    const proof = Schema.decodeUnknownSync(Proof)(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    )
    if (proof.expiresAt <= now) throw new Error("Expired")
    return proof
  } catch {
    throw new EmailRejected({
      message:
        "This email approval is invalid or has expired. Review the current action in Pi.",
    })
  }
}

export const emailApprovalProofs = (secret: string): EmailApprovalProofs => ({
  sign: (recipient, approval) =>
    emailApprovalToken(secret, recipient, approval),
  verify: (recipient, token, now) =>
    emailApprovalProof(secret, recipient, token, now),
})
