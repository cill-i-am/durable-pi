import { Schema } from "effect"

import { nativeOperation } from "../../shared/interop"
import type { EmailRecord } from "../contracts"
import { EmailSendFailed } from "../pump"

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
  text: string
) =>
  nativeOperation(
    async () => {
      const response = await binding.send({
        from: record.recipient,
        to: record.sender,
        replyTo: record.recipient,
        subject: /^re:/i.test(record.subject)
          ? record.subject
          : `Re: ${record.subject || "Your request"}`,
        text,
        html: `<pre>${text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</pre>`,
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
      return response.messageId
    },
    (cause, channel) => {
      if (channel === "failure" || Schema.isSchemaError(cause)) throw cause
      const decoded = Schema.decodeUnknownOption(
        Schema.Struct({ code: Schema.String })
      )(cause)
      return new EmailSendFailed({
        uncertain: decoded._tag === "None" || !rejected.has(decoded.value.code),
      })
    }
  )
