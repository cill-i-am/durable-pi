import { readFile, writeFile } from "node:fs/promises"
import { parseArgs } from "node:util"

import { invitationCases } from "./cases"
import { gradeInvitation, invitationEvidence } from "./grade"

const { values } = parseArgs({
  options: {
    case: { type: "string" },
    recipient: { type: "string" },
    archive: { type: "string" },
    ui: { type: "string" },
    output: { type: "string" },
  },
})
const test = invitationCases(values.recipient).find(
  (item) => item.id === values.case
)
if (!test || !values.archive)
  throw new Error(
    "Use --case <id> --archive <path> [--recipient <exact-email>] [--ui <path>] [--output <path>]"
  )
const ui = values.ui
  ? invitationEvidence.parse(JSON.parse(await readFile(values.ui, "utf8")))
  : undefined
const result = gradeInvitation(test, await readFile(values.archive, "utf8"), ui)
if (values.output)
  await writeFile(values.output, JSON.stringify(result, null, 2), {
    mode: 0o600,
  })
console.log(
  JSON.stringify(
    { id: result.id, pass: result.pass, checks: result.checks },
    null,
    2
  )
)
if (!result.pass) process.exitCode = 1
