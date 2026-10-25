import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { after, test } from "node:test"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
mkdirSync(join(root, ".research"), { recursive: true })
const directory = mkdtempSync(join(root, ".research", "typecheck-smoke-"))
const project = join(directory, "tsconfig.json")
writeFileSync(
  project,
  JSON.stringify({
    extends: "../../tsconfig.json",
    files: ["fixture.ts"],
    include: [],
    exclude: [],
  })
)
after(() => rmSync(directory, { recursive: true, force: true }))

function run(compiler, source) {
  writeFileSync(join(directory, "fixture.ts"), source)
  const args =
    compiler === "effect"
      ? [
          "node_modules/@yielded/effect-tsrs/bin/effect-tsrs.js",
          "diagnostics",
          "-p",
          project,
          "--format",
          "json",
          "--lspconfig",
          "{}",
        ]
      : [
          compiler === "tsc"
            ? "node_modules/@typescript/native/bin/tsc"
            : "node_modules/tsrs/bin/tsrs",
          "--noEmit",
          "--pretty",
          "false",
          "-p",
          project,
        ]
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  assert.ifError(result.error)
  assert.equal(result.signal, null, result.stderr)
  return result
}

void test("both compilers accept valid types and reject an ordinary type error", () => {
  for (const compiler of ["tsc", "tsrs"]) {
    const valid = run(compiler, "export const answer: number = 42\n")
    assert.equal(valid.status, 0, valid.stdout + valid.stderr)
    const invalid = run(compiler, 'export const answer: number = "wrong"\n')
    assert.notEqual(invalid.status, 0)
    assert.match(invalid.stdout, /TS2322/)
  }
})

void test("both compilers preserve recursive JSON input and output types", () => {
  const imports = `import { z } from "zod"
import { toolCall } from "../../evals/tool-call"
`
  for (const compiler of ["tsc", "tsrs"]) {
    const valid = run(
      compiler,
      `${imports}
export const input: z.input<typeof toolCall> = {
  name: "example", arguments: { nested: [{ value: [null, true, "text", 42] }] }
}
export const output: { name: string; arguments: Record<string, z.core.util.JSONType> } = toolCall.parse(input)
`
    )
    assert.equal(valid.status, 0, valid.stdout + valid.stderr)
    for (const direction of ["input", "output"]) {
      const invalid = run(
        compiler,
        `${imports}
export const invalid: z.${direction}<typeof toolCall> = {
  name: "example", arguments: { nested: [{ value: () => null }] }
}
`
      )
      assert.notEqual(invalid.status, 0)
      assert.match(invalid.stdout, /TS2322/)
    }
    const missing = run(
      compiler,
      `${imports}
export const missing: z.input<typeof toolCall> = { name: "example" }
`
    )
    assert.notEqual(missing.status, 0)
    assert.match(missing.stdout, /TS2741/)
  }
})

void test("Effect checking catches an unexecuted Effect that TypeScript accepts", () => {
  const source = 'import { Effect } from "effect"\nEffect.succeed(42)\n'
  const ordinary = run("tsc", source)
  assert.equal(ordinary.status, 0, ordinary.stdout + ordinary.stderr)
  const checked = run("effect", source)
  assert.equal(checked.status, 1, checked.stdout + checked.stderr)
  const report = JSON.parse(checked.stdout)
  assert.equal(report.summary.filesChecked, 1)
  assert.ok(
    report.diagnostics.some(
      (d) => d.name === "floatingEffect" && d.severity === "error"
    )
  )
})

void test("Effect checking accepts a yielded Effect and rejects bare yield", () => {
  const checked = run(
    "effect",
    'import { Effect } from "effect"\nexport const task = Effect.gen(function* () { yield* Effect.void })\n'
  )
  assert.equal(checked.status, 0, checked.stdout + checked.stderr)
  assert.equal(JSON.parse(checked.stdout).summary.filesChecked, 1)
  const invalid = run(
    "effect",
    'import { Effect } from "effect"\nexport const task = Effect.gen(function* () { yield Effect.void })\n'
  )
  assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr)
  assert.ok(
    JSON.parse(invalid.stdout).diagnostics.some(
      (d) => d.name === "missingStarInYieldEffectGen"
    )
  )
})
