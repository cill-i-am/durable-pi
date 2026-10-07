import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
const findings: string[] = []
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:ghp|gho|github_pat)_[a-zA-Z0-9_]{25,}\b/,
  /\bsk-(?:proj-)?[a-zA-Z0-9_-]{30,}\b/,
]
const forbidden =
  /(^|\/)(?:\.env(?:\..+)?|\.dev\.vars(?:\..+)?|auth\.json|credentials[^/]*\.json|\.alchemy\/|\.research\/)/
const values = [
  process.env.BETTER_AUTH_SECRET,
  process.env.SETUP_TOKEN,
  process.env.OWNER_EMAIL,
]
if (process.env.OPENAI_CREDENTIAL) {
  try {
    const c = JSON.parse(process.env.OPENAI_CREDENTIAL)
    values.push(c.access, c.refresh, c.key)
  } catch {
    throw new Error("Malformed credential in local scan environment")
  }
}
for (const file of files) {
  if (forbidden.test(file) && file !== ".env.example")
    findings.push(`${file}: private configuration must not be tracked`)
  const text = readFileSync(file, "utf8")
  if (patterns.some((pattern) => pattern.test(text)))
    findings.push(`${file}: possible credential`)
  if (
    values.some(
      (value) =>
        typeof value === "string" && value.length > 8 && text.includes(value)
    )
  )
    findings.push(`${file}: contains a private configuration value`)
}
if (findings.length) {
  console.error(findings.join("\n"))
  process.exitCode = 1
} else
  console.log(`Checked ${files.length} tracked files; no credential matches.`)
