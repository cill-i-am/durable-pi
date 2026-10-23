import { Effect, Schema } from "effect"

import { nativeFailure } from "../../shared/interop"
import type { EmailRecord } from "../contracts"
import { EmailSendFailed } from "../pump"
import { renderReplyEmail } from "./template"

const rejected = new Set([
  "E_VALIDATION_ERROR",
  "E_FIELD_MISSING",
  "E_TOO_MANY_RECIPIENTS",
  "E_SENDER_NOT_VERIFIED",
  "E_RECIPIENT_NOT_ALLOWED",
  "E_RECIPIENT_SUPPRESSED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE",
  "E_CONTENT_TOO_LARGE",
  "E_RATE_LIMIT_EXCEEDED",
  "E_DAILY_LIMIT_EXCEEDED",
  "E_HEADER_NOT_ALLOWED",
  "E_HEADER_USE_API_FIELD",
  "E_HEADER_VALUE_INVALID",
  "E_HEADER_VALUE_TOO_LONG",
  "E_HEADER_NAME_INVALID",
  "E_HEADERS_TOO_LARGE",
  "E_HEADERS_TOO_MANY",
])
export const sendEmailReply = (
  binding: SendEmail,
  record: EmailRecord,
  text: string,
  attachments: EmailAttachment[] = []
) =>
  Effect.suspend(() => {
    const html = renderReplyEmail(record, text)
    // SendEmail exposes neither cancellation nor a local resource to release.
    // Own observation of this RPC, not its remote lifetime: the reply deadline
    // may stop waiting with durable uncertainty while the provider still runs.
    return Effect.tryPromise({
      try: async () => {
        const response = await binding.send({
          from: record.recipient,
          to: record.sender,
          replyTo: record.recipient,
          subject: /^re:/i.test(record.subject)
            ? record.subject
            : `Re: ${record.subject || "Your request"}`,
          text,
          attachments,
          html,
          headers: {
            ...(record.messageId
              ? {
                  "In-Reply-To": record.messageId,
                  References: `${record.references} ${record.messageId}`.trim(),
                }
              : {}),
            "Auto-Submitted": "auto-replied",
          },
        })
        if (!response.messageId)
          throw new Error("Email provider returned no message receipt")
        return response.messageId
      },
      catch: (cause) =>
        nativeFailure(cause, (reason, channel) => {
          if (channel === "failure" || Schema.isSchemaError(reason))
            throw reason
          const decoded = Schema.decodeUnknownOption(
            Schema.Struct({ code: Schema.String })
          )(reason)
          return new EmailSendFailed({
            uncertain:
              decoded._tag === "None" || !rejected.has(decoded.value.code),
          })
        }),
    }).pipe(Effect.catch((cause) => Effect.failCause(cause)))
  })
