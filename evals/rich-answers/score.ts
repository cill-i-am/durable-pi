import { readFile, writeFile } from "node:fs/promises"
import { parseArgs } from "node:util"

import { cases } from "./cases"
import { grade, uiEvidence } from "./grade"

const { values } = parseArgs({
  options: {
    case: { type: "string" },
    archive: { type: "string" },
    ui: { type: "string" },
    output: { type: "string" },
  },
})
const test = cases.find((item) => item.id === values.case)
if (!test || !values.archive)
  throw new Error(
    "Use --case <id> --archive <path> [--ui <path>] [--output <path>]"
  )
const ui = values.ui
  ? uiEvidence.parse(JSON.parse(await readFile(values.ui, "utf8")))
  : undefined
const result = grade(test, await readFile(values.archive, "utf8"), ui)
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
