import { renderToStaticMarkup } from "react-dom/server.edge"
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from "react-email"

import type { EmailRecord } from "../contracts"

const commandMarker =
  "\n\nTo allow this call once, reply with this as the first line:\n"
export function renderReplyEmail(record: EmailRecord, text: string) {
  const marker =
    record.purpose === "notification" ? text.lastIndexOf(commandMarker) : -1
  const token =
    marker >= 0
      ? /^APPROVE ([A-Za-z0-9_.-]+)$/m.exec(text.slice(marker))?.[1]
      : undefined
  const reviewUrl = /\n\nView this agent in Pi: (https?:\/\/[^\s]+)$/.exec(
    text
  )?.[1]
  const content =
    marker >= 0
      ? text.slice(0, marker)
      : text.replace(/\n\nView this agent in Pi: https?:\/\/[^\s]+$/, "")
  const reply = (approve: boolean) =>
    `mailto:${record.recipient}?${new URLSearchParams({ subject: /^re:/i.test(record.subject) ? record.subject : `Re: ${record.subject}`, body: `${approve ? "APPROVE" : "DENY"} ${token}` })}`
  // Email is static markup. The explicit edge renderer avoids Node stream and
  // dynamic renderer selection in a Durable Object's send lifecycle.
  return (
    "<!DOCTYPE html>" +
    renderToStaticMarkup(
      <Html lang="en">
        <Head />
        <Preview>
          {token
            ? "An action needs your approval"
            : "Your assistant has replied"}
        </Preview>
        <Body
          style={{
            backgroundColor: "#f6f5f7",
            color: "#171619",
            fontFamily:
              "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
            margin: 0,
            padding: "24px 12px",
          }}
        >
          <Container
            style={{
              backgroundColor: "#ffffff",
              border: "1px solid #e8e6ea",
              borderRadius: 12,
              maxWidth: 600,
              padding: 28,
            }}
          >
            <Text
              style={{ color: "#68666e", fontSize: 13, margin: "0 0 20px" }}
            >
              Pi · Your personal assistant
            </Text>
            {token && (
              <Heading
                as="h1"
                style={{ fontSize: 24, lineHeight: "32px", margin: "0 0 20px" }}
              >
                Your approval is needed
              </Heading>
            )}
            <Section
              style={{
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                fontSize: 15,
                lineHeight: "24px",
              }}
            >
              {content.replace(/^An action needs your approval\.\n\n/, "")}
            </Section>
            {token && (
              <>
                <Section style={{ marginTop: 24 }}>
                  <Button
                    href={reply(true)}
                    style={{
                      backgroundColor: "#171619",
                      borderRadius: 8,
                      color: "#ffffff",
                      padding: "12px 20px",
                      marginRight: 12,
                    }}
                  >
                    Approve once
                  </Button>
                  <Button
                    href={reply(false)}
                    style={{
                      backgroundColor: "#efedf1",
                      borderRadius: 8,
                      color: "#171619",
                      padding: "12px 20px",
                    }}
                  >
                    Deny
                  </Button>
                </Section>
                <Text
                  style={{ color: "#68666e", fontSize: 13, lineHeight: "20px" }}
                >
                  A button opens a prepared email. Send it to confirm your
                  decision. This applies only to the action above. Keep this
                  email private.
                </Text>
                <Text
                  style={{
                    color: "#68666e",
                    fontSize: 12,
                    lineHeight: "18px",
                    overflowWrap: "anywhere",
                  }}
                >
                  You can also reply with this as the first line:
                  <br />
                  APPROVE {token}
                  <br />
                  or
                  <br />
                  DENY {token}
                </Text>
              </>
            )}
            {reviewUrl && (
              <Text style={{ margin: "24px 0 0", fontSize: 13 }}>
                <Link href={reviewUrl} style={{ color: "#171619" }}>
                  View this agent in Pi
                </Link>
              </Text>
            )}
          </Container>
        </Body>
      </Html>
    )
  )
}
