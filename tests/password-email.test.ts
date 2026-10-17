import { describe, expect, it } from "vitest"

import {
  passwordResetEmail,
  PASSWORD_RESET_SECONDS,
  PASSWORD_EMAIL_FROM,
} from "../src/auth/password-email"

describe("password recovery mail", () => {
  it("keeps the reset token out of HTTP paths, queries, and access logs", () => {
    const mail = passwordResetEmail(
      "https://bot.example.com",
      "test-token",
      "owner@example.com"
    )
    const match = mail.text.match(/https:\/\/\S+/)![0]
    const url = new URL(match)
    expect(url.origin).toBe("https://bot.example.com")
    expect(url.pathname).toBe("/reset-password")
    expect(url.search).toBe("")
    expect(new URLSearchParams(url.hash.slice(1)).get("token")).toBe(
      "test-token"
    )
    expect(mail.to).toBe("owner@example.com")
    expect(mail.from.email).toBe(PASSWORD_EMAIL_FROM)
    expect(PASSWORD_RESET_SECONDS).toBe(900)
  })
  it("encodes untrusted token characters and does not interpolate the recipient into HTML", () => {
    const mail = passwordResetEmail(
      "https://bot.example.com",
      '<a href="https://attacker.example">&',
      "<owner@example.com>"
    )
    expect(mail.html).not.toContain("<owner")
    expect(mail.html).not.toContain('<a href="https://attacker.example">')
    expect(mail.html).toContain("https://bot.example.com/reset-password#token=")
  })
})
